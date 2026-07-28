# Repo / Code Ingestion — Design (Phase 2)

**Date:** 2026-07-28
**Status:** Building autonomously (user: "proceed with repo ingestion"). Design decisions locked in the prior brainstorm.

## Problem

Today `search_code` is a live pass-through to Bitbucket's built-in search — it indexes nothing. Users need to ingest one or more (potentially huge) git repos *into* the EIL catalog so code becomes token-free, FTS + semantic searchable, ACL-filtered knowledge like Confluence/Jira — with cheap incremental re-sync and correct deletions.

## Decisions (locked with user)

1. **Pluggable `RepoSource`** — two implementations behind one interface: `GitCloneSource` (any git host or local path) and `BitbucketApiSource` (no clone). One source-agnostic orchestrator.
2. **All four granularity knobs:** one or more whole repos; `--subpath` (monorepo slice); `--branch`; `--include`/`--exclude` globs. Plus always-on binary + size-cap skipping (logged, never silent).
3. **Code-aware line-window chunker** — dispatched inside the existing `chunk()` seam on `source === "code"`; the prose (golden-tested) path is untouched.
4. **Per-repo commit-SHA cursor + git diff** — incremental re-sync fetches only changed files; deletions are intrinsic (`D` status → tombstone). No `--reconcile`.

**No migration:** `documents`/`chunks`/`sync_cursors` already suffice; `source="code"` is just a value and the cursor is a scope-key string (reuses the scoped-ingestion pattern).

## RepoSource interface (`ts/connectors/reposource.ts`)

```ts
export interface RepoChange { path: string; status: "A" | "M" | "D" }
export interface RepoSource {
  headSha(): Promise<string>;                       // current head of the (branch,)
  listFiles(): AsyncGenerator<string>;              // all file paths at head, already subpath-filtered
  changedSince(sha: string): AsyncGenerator<RepoChange>;  // A/M/D since sha (subpath-filtered)
  readFile(path: string): Promise<string>;          // file text at head
  blobUrl(path: string): string | null;             // host link for the doc, or null
  dispose(): Promise<void>;                          // cleanup (git: no-op, persistent cache)
}
export interface RepoConfig { ref: string; branch?: string; subpath?: string }
```

### GitCloneSource (verified against a real repo)
- Persistent per-repo cache dir: `${EIL_REPO_CACHE ?? ".eil-repos"}/<repoKey>`.
- Clone if absent: `git clone --filter=blob:none --single-branch [--branch <b>] <ref> <dir>` (treeless partial clone — cheap history, blobs on demand; handles huge repos). A local-path `ref` clones the same way.
- Every run first syncs: `git -C <dir> fetch --quiet` then resolve head from `origin/<branch>` (or `HEAD`); reset is unnecessary since we read by rev.
- `headSha`: `git -C <dir> rev-parse <branch-or-HEAD>`.
- `listFiles`: `git -C <dir> ls-files -- <subpath?>` → one path per line.
- `changedSince(sha)`: `git -C <dir> diff --name-status <sha> <head> -- <subpath?>`; parse tab-separated `status\tpath` (`M/A/D`); a rename `R<score>\told\tnew` → emit `{D, old}` + `{A, new}`. If `<sha>` is unreachable (force-push), the command fails → orchestrator falls back to a full `listFiles` sweep.
- `readFile`: `git -C <dir> show <head>:<path>` (blob fetched on demand).
- `blobUrl`: best-effort from a recognized host (Bitbucket/GitHub URL shape), else null.
- git runs via `execFile` (async) with a bounded buffer; non-zero exit throws a clean error.

### BitbucketApiSource
- Reuses `makeClient("BITBUCKET")` (`EIL_BITBUCKET_URL/TOKEN`). `ref` = `PROJECT/repo`.
- `headSha`: `GET /rest/api/1.0/projects/{P}/repos/{R}/commits?until=<branch>&limit=1` → `values[0].id`.
- `listFiles`: `GET /rest/api/1.0/projects/{P}/repos/{R}/files/<subpath?>?at=<sha>` (paged) → paths.
- `changedSince(sha)`: `GET .../compare/changes?from=<sha>&to=<head>` → `values[].path.toString` + `type` (`ADD/MODIFY/DELETE` → `A/M/D`, `COPY/MOVE` handled like git rename).
- `readFile`: `GET .../raw/<path>?at=<sha>`.
- `blobUrl`: `${base}/projects/{P}/repos/{R}/browse/<path>?at=<sha>`.

## File filtering (`ts/ingest/repofilter.ts`, pure)

- `globToRegExp(glob)` — minimal, dependency-free: supports `**` (any dirs), `*` (any non-`/`), `?`; anchored full-path match. Documented subset.
- `RepoFilter { includes: string[]; excludes: string[]; maxBytes: number }`:
  - `acceptPath(path)` — passes if (no includes OR matches an include) AND matches no exclude.
  - `acceptContent(text)` — false if a NUL byte appears in the first 8KB (binary) or `byteLength > maxBytes`.
- `maxBytes` default `EIL_REPO_MAX_BYTES ?? 524288` (512KB). Skipped files are **counted and logged**.

## Code doc model (`ts/ingest/code.ts`)

- `normalizeCode(repoKey, path, content, url, tenant): CanonicalDoc`:
  - `id` = `code:${repoKey}:${path}`; `source` = `"code"`; `title` = `path`;
  - `hierarchy` = `[repoKey, ...dirsOf(path)]`; `body` = raw content; `url`;
  - `aclGroups: []` (fail-closed — clone/PAT access is the ACL); `qualityTier: "authored"`; `links: []`.
- `repoKey(ref, override?)`: `--name` override wins; else derive `org/repo` (or `PROJECT/repo`) from the ref, stripping scheme/host/`.git`; local path → dir basename.
- `detectSource(ref)`: `git` if ref has `://`, starts with `git@`, or is an existing local path; `bitbucket` if it matches `PROJECT/repo` (one slash, no scheme). `--source` overrides.

## Code-aware chunker (dispatch in `ts/core/chunker.ts`)

`chunk(doc)` gains a top branch: `if (doc.source === "code") return chunkCode(doc)`. Prose path unchanged (golden files intact).

`chunkCode(doc)`: split `body` into lines; emit fixed windows of `CODE_WINDOW_LINES` (60) with `CODE_OVERLAP_LINES` (10) overlap; each chunk's `headingPath` = `${doc.title} › L${start}-${end}` (1-based, for citation), `text` = `${headingPath}\n\n${window}` (self-describing, matching the prose chunk convention); `seq` increments. Deterministic → golden-testable.

## Orchestrator (`ingestRepo` in `ts/ingest/pipeline.ts`)

```ts
ingestRepo(source: RepoSource, repoKey: string, subpath: string | undefined,
           filter: RepoFilter, tenant: string): Promise<void>
```
- Cursor key: `code:${repoKey}${subpath ? ":"+subpath : ""}` (reuses `sync_cursors`).
- `head = await source.headSha()`. If `cursor === head` → "up to date", return.
- **Incremental** (cursor set): for each `changedSince(cursor)` change — `D` → tombstone `code:${repoKey}:${path}`; `A`/`M` → if `filter.acceptPath`, read + `acceptContent`, else skip (log); upsert `normalizeCode(...)`. On `changedSince` failure (unreachable sha) → fall through to full.
- **Full** (no cursor): for each `listFiles()` path — `acceptPath` → read → `acceptContent` → upsert.
- After success: `setCursor(cursorKey, head)`; `source.dispose()`. Log counts: `N upserted, M deleted, K skipped (binary/size/glob)`.
- `tombstone(client, id, tenant)`: `DELETE FROM documents WHERE id=$1 AND tenant=$2` (chunks cascade).

Upserts reuse `upsertDocument` (hash-gated, chunks via the code-aware `chunk()`).

## CLI (`eil ingest repo`)

```
eil ingest repo <ref> [<ref2> ...]
  [--source git|bitbucket]  [--branch B]  [--subpath P]
  [--include GLOB]…(repeatable) [--exclude GLOB]…(repeatable)
  [--name KEY]  [--tenant t]
```
- One or more refs; each ingested independently (own cursor). Flags apply to all refs in the run.
- `--source` auto-detected per ref unless given. Deletions handled inline (no `--reconcile`).
- Missing Bitbucket creds → the existing `liveClient` clean error; git errors surface cleanly.

## Testing

- **Code chunker (golden/pure, CI):** `chunkCode` line windows + `L`-range headings, deterministic; `chunk()` dispatch — a `source:"code"` doc uses code path, a prose doc is byte-identical (existing golden untouched).
- **repofilter (pure, CI):** glob matching (`**/*.ts`, `**/vendor/**`, `?`); binary NUL detection; size cap; skip-counting.
- **GitCloneSource (real git, CI):** the test builds a real temp git repo (init, commit, modify+delete+add, commit), points `GitCloneSource` at the local path, and asserts `headSha`, `listFiles` (+subpath), `changedSince` (A/M/D), `readFile`. Highest-value integration test.
- **BitbucketApiSource (mock fetch, CI):** asserts the endpoints + parsing (headSha, listFiles paging, compare→A/M/D mapping, readFile, blobUrl).
- **Orchestrator (PGlite + fake RepoSource, CI):** first ingest upserts `source:"code"` docs + sets the per-repo cursor to head; incremental applies A/M (upsert) + D (tombstone) + advances cursor; filters skip excluded/binary/oversize with logged counts; `cursor === head` short-circuits.
- **CLI (pure, CI):** `detectSource`, `repoKey` derivation, multi-ref parsing.

## Non-Goals (v1)

- Symbol/AST-aware chunking (line windows only), import-graph `links`, submodules, LFS.
- pgvector for code embeddings (semantic search already applies to `source:"code"` chunks via backfill — free).
- Auth beyond existing Bitbucket PAT / local git credentials.

## Files

- Create `ts/connectors/reposource.ts` (interface + GitCloneSource + BitbucketApiSource), `ts/ingest/repofilter.ts`, `ts/ingest/code.ts`.
- Modify `ts/core/chunker.ts` (code dispatch), `ts/ingest/pipeline.ts` (`ingestRepo` + `tombstone`), `ts/cli.ts` (`ingest repo`).
- Tests: `ts/tests/repo.test.ts` (chunker, filter, git, bitbucket, orchestrator), `README.md`.
