# Repo / Code Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest one or more (huge) git repos into the catalog as `source="code"` docs — searchable via FTS + semantic, ACL-filtered — with subpath/branch/glob selection, a code-aware chunker, and cheap commit-SHA-cursor incremental sync with intrinsic deletions.

**Architecture:** A pluggable `RepoSource` (`GitCloneSource` treeless partial clone + `BitbucketApiSource`) behind one interface, a source-agnostic `ingestRepo` orchestrator reusing `upsertDocument`/`sync_cursors`, a code-aware chunker dispatched inside `chunk()`, and pure file-filter + doc-normalize helpers. No migration.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), node:child_process (git), pg/PGlite, commander, vitest, biome. No new deps.

## Global Constraints

- Node 22+, ESM, `.js` specifiers, strict tsc, biome clean, no new deps.
- **Prose chunker is frozen:** `chunk()` for non-`code` docs must stay byte-identical (golden files under `tests/golden/` are the contract). Only add a `source==="code"` branch.
- **No migration:** `source="code"`, doc id `code:<repoKey>:<path>`, cursor key `code:<repoKey>[:<subpath>]` in `sync_cursors`.
- **ACL fail-closed:** code docs get `aclGroups: []`.
- **Deletions intrinsic:** `changedSince` `D` → tombstone; no `--reconcile`.
- **No silent drops:** binary/size/glob-skipped files are counted and logged.
- Git via `execFile` (async), bounded buffer, non-zero exit throws cleanly.

## File Structure

- Create `ts/ingest/repofilter.ts`, `ts/ingest/code.ts`, `ts/connectors/reposource.ts`.
- Modify `ts/core/chunker.ts` (+`chunkCode`, dispatch), `ts/ingest/pipeline.ts` (+`ingestRepo`,`tombstone`), `ts/cli.ts` (+`ingest repo`).
- Create `ts/tests/repo.test.ts`; modify `README.md`.

---

### Task 1: Code-aware chunker

**Files:** Modify `ts/core/chunker.ts`; Test `ts/tests/repo.test.ts`.
**Interfaces:** Produces `CODE_WINDOW_LINES`, `CODE_OVERLAP_LINES`, `chunkCode(doc): Chunk[]`; `chunk()` dispatches on `source==="code"`.

- [ ] **Step 1: Failing test**

```ts
// ts/tests/repo.test.ts
import { describe, expect, it } from "vitest";
import { chunk } from "../core/chunker.js";

const codeDoc = (body: string) =>
  ({ id: "code:r:a.ts", tenant: "default", source: "code", title: "src/a.ts",
     hierarchy: ["r", "src"], aclGroups: [], qualityTier: "authored", body, links: [] }) as any;

describe("code chunker", () => {
  it("windows code by lines with L-range headings", () => {
    const body = Array.from({ length: 130 }, (_, i) => `line${i + 1}`).join("\n");
    const chunks = chunk(codeDoc(body));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.headingPath).toBe("src/a.ts › L1-60");
    expect(chunks[0]!.text.startsWith("src/a.ts › L1-60\n\n")).toBe(true);
    expect(chunks[0]!.text).toContain("line1");
    // overlap: window 2 starts before window 1 ends (60 - 10 = 51)
    expect(chunks[1]!.headingPath).toBe("src/a.ts › L51-110");
    // deterministic
    expect(chunk(codeDoc(body))).toEqual(chunks);
  });
  it("leaves the prose path unchanged for non-code docs", () => {
    const prose = { id: "x", tenant: "default", source: "jira", title: "T",
      hierarchy: [], aclGroups: [], qualityTier: "authored",
      body: "## H\n\nsome text", links: [] } as any;
    const chunks = chunk(prose);
    expect(chunks[0]!.headingPath).toContain("T"); // section breadcrumb, not L-range
    expect(chunks[0]!.headingPath).not.toMatch(/› L\d/);
  });
});
```

- [ ] **Step 2: Run → fail** `pnpm exec vitest run ts/tests/repo.test.ts` (chunkCode absent → prose path emits wrong headings).

- [ ] **Step 3: Implement** — in `ts/core/chunker.ts` add before `export function chunk`:

```ts
export const CODE_WINDOW_LINES = 60;
export const CODE_OVERLAP_LINES = 10;

/** Deterministic line-window chunker for code: fixed windows with overlap,
 *  line ranges preserved in the heading for citation. */
export function chunkCode(doc: CanonicalDoc): Chunk[] {
  const lines = doc.body.split("\n");
  const chunks: Chunk[] = [];
  const step = CODE_WINDOW_LINES - CODE_OVERLAP_LINES;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + CODE_WINDOW_LINES, lines.length);
    const headingPath = `${doc.title} › L${start + 1}-${end}`;
    const window = lines.slice(start, end).join("\n");
    chunks.push({ docId: doc.id, seq: chunks.length, headingPath, text: `${headingPath}\n\n${window}` });
    if (end === lines.length) break;
  }
  return chunks;
}
```
and make `chunk` dispatch — first line of its body:
```ts
export function chunk(doc: CanonicalDoc): Chunk[] {
  if (doc.source === "code") return chunkCode(doc);
  const chunks: Chunk[] = [];
  // ...existing prose body unchanged...
```

- [ ] **Step 4: Run → pass**, plus regression: `EIL_DATABASE_URL=pglite://.eil-c pnpm exec vitest run && rm -rf .eil-c` (existing chunker golden tests stay green).

- [ ] **Step 5: Commit** `git add ts/core/chunker.ts ts/tests/repo.test.ts && git commit -m "chunker: code-aware line-window chunking dispatched on source=code"`

---

### Task 2: File filter (glob + binary + size)

**Files:** Create `ts/ingest/repofilter.ts`; Test `ts/tests/repo.test.ts`.
**Interfaces:** Produces `globToRegExp(glob): RegExp`; `class RepoFilter { constructor(o:{includes?:string[];excludes?:string[];maxBytes?:number}); acceptPath(p:string):boolean; acceptContent(text:string):boolean }`.

- [ ] **Step 1: Failing test**

```ts
// append to ts/tests/repo.test.ts
import { RepoFilter, globToRegExp } from "../ingest/repofilter.js";

describe("repofilter", () => {
  it("globs with **, *, ?", () => {
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a/b/c.js")).toBe(false);
    expect(globToRegExp("**/vendor/**").test("x/vendor/y/z.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false); // * doesn't cross /
  });
  it("acceptPath honors includes then excludes", () => {
    const f = new RepoFilter({ includes: ["**/*.ts"], excludes: ["**/generated/**"] });
    expect(f.acceptPath("src/a.ts")).toBe(true);
    expect(f.acceptPath("src/a.js")).toBe(false);       // not included
    expect(f.acceptPath("src/generated/a.ts")).toBe(false); // excluded
  });
  it("no includes = accept all except excludes", () => {
    const f = new RepoFilter({ excludes: ["**/*.lock"] });
    expect(f.acceptPath("a/b.ts")).toBe(true);
    expect(f.acceptPath("a/b.lock")).toBe(false);
  });
  it("acceptContent rejects binary and oversize", () => {
    const f = new RepoFilter({ maxBytes: 100 });
    expect(f.acceptContent("clean text")).toBe(true);
    expect(f.acceptContent("has\0nul")).toBe(false);      // binary
    expect(f.acceptContent("x".repeat(101))).toBe(false); // oversize
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
// ts/ingest/repofilter.ts
/** Dependency-free path globbing + binary/size gating for repo ingestion. */

/** Supports ** (any chars incl. '/'), * (any run of non-slash), ? (one non-slash). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i += 2;
      if (glob[i] === "/") { re += "(?:.*/)?"; i++; } // **/ matches zero or more leading dirs
      else re += ".*";
    } else if (c === "*") {
      re += "[^/]*"; i++;
    } else if (c === "?") {
      re += "[^/]"; i++;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&"); i++;
    }
  }
  return new RegExp(`^${re}$`);
}

export class RepoFilter {
  private readonly includes: RegExp[];
  private readonly excludes: RegExp[];
  private readonly maxBytes: number;
  constructor(o: { includes?: string[]; excludes?: string[]; maxBytes?: number }) {
    this.includes = (o.includes ?? []).map(globToRegExp);
    this.excludes = (o.excludes ?? []).map(globToRegExp);
    this.maxBytes = o.maxBytes ?? Number(process.env.EIL_REPO_MAX_BYTES ?? 524288);
  }
  acceptPath(path: string): boolean {
    if (this.includes.length > 0 && !this.includes.some((r) => r.test(path))) return false;
    if (this.excludes.some((r) => r.test(path))) return false;
    return true;
  }
  acceptContent(text: string): boolean {
    if (Buffer.byteLength(text, "utf-8") > this.maxBytes) return false;
    return !text.slice(0, 8192).includes("\0");
  }
}
```
(Note: keep `globToRegExp` simple and correct for `**`, `**/`, `*`, `?`; the test pins the exact behaviors. Implementers: verify the `**` branch against the tests and simplify the code to whatever passes them cleanly — the reference above prioritizes correctness of the test cases over elegance.)

- [ ] **Step 4: Run → pass; typecheck/lint.**

- [ ] **Step 5: Commit** `git add ts/ingest/repofilter.ts ts/tests/repo.test.ts && git commit -m "repo: dependency-free glob + binary/size file filter"`

---

### Task 3: Code doc normalize + repoKey + source detection

**Files:** Create `ts/ingest/code.ts`; Test `ts/tests/repo.test.ts`.
**Interfaces:** Produces `normalizeCode(repoKey, path, content, url, tenant): CanonicalDoc`; `repoKey(ref: string, override?: string): string`; `detectSource(ref: string): "git" | "bitbucket"`.

- [ ] **Step 1: Failing test**

```ts
// append to ts/tests/repo.test.ts
import { detectSource, normalizeCode, repoKey } from "../ingest/code.js";

describe("code doc model", () => {
  it("normalizeCode builds a code CanonicalDoc", () => {
    const d = normalizeCode("org/repo", "src/pay/retry.ts", "const x=1\n", "https://h/browse/src/pay/retry.ts", "default");
    expect(d.id).toBe("code:org/repo:src/pay/retry.ts");
    expect(d.source).toBe("code");
    expect(d.title).toBe("src/pay/retry.ts");
    expect(d.hierarchy).toEqual(["org/repo", "src", "pay"]);
    expect(d.aclGroups).toEqual([]);
    expect(d.url).toBe("https://h/browse/src/pay/retry.ts");
    expect(d.body).toBe("const x=1\n");
  });
  it("repoKey derives org/repo, honors override, strips .git", () => {
    expect(repoKey("https://bb.corp/scm/PAY/retry.git")).toBe("PAY/retry");
    expect(repoKey("git@github.com:org/repo.git")).toBe("org/repo");
    expect(repoKey("/home/me/work/myrepo")).toBe("myrepo");
    expect(repoKey("anything", "custom")).toBe("custom");
  });
  it("detectSource routes by ref shape", () => {
    expect(detectSource("https://bb/scm/x/y.git")).toBe("git");
    expect(detectSource("git@github.com:o/r.git")).toBe("git");
    expect(detectSource("PAY/retry")).toBe("bitbucket");
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
// ts/ingest/code.ts
/** Map a repo file into a CanonicalDoc (source="code"), plus ref helpers. */
import type { CanonicalDoc } from "../contracts/models.js";
import { existsSync } from "node:fs";

export function normalizeCode(
  key: string, path: string, content: string, url: string | null, tenant: string,
): CanonicalDoc {
  const dirs = path.split("/").slice(0, -1);
  return {
    id: `code:${key}:${path}`, tenant, source: "code", title: path,
    url: url ?? undefined, hierarchy: [key, ...dirs], aclGroups: [],
    qualityTier: "authored", body: content, links: [],
  };
}

/** org/repo (or PROJECT/repo) from a ref; local path -> basename; override wins. */
export function repoKey(ref: string, override?: string): string {
  if (override) return override;
  let s = ref.replace(/\.git$/, "");
  if (s.includes("://")) {
    const parts = s.split("://")[1]!.split("/").filter(Boolean).slice(1); // drop host
    return parts.slice(-2).join("/") || parts.join("/");
  }
  if (s.startsWith("git@")) {
    s = s.split(":")[1] ?? s; // git@host:org/repo
    return s.split("/").slice(-2).join("/");
  }
  return s.replace(/\/+$/, "").split("/").pop() ?? s; // local path
}

export function detectSource(ref: string): "git" | "bitbucket" {
  if (ref.includes("://") || ref.startsWith("git@") || existsSync(ref)) return "git";
  if (/^[^/]+\/[^/]+$/.test(ref)) return "bitbucket";
  return "git";
}
```

- [ ] **Step 4: Run → pass; typecheck/lint.**

- [ ] **Step 5: Commit** `git add ts/ingest/code.ts ts/tests/repo.test.ts && git commit -m "repo: code doc normalize + repoKey/source-detect helpers"`

---

### Task 4: RepoSource interface + GitCloneSource (real-git test)

**Files:** Create `ts/connectors/reposource.ts`; Test `ts/tests/repo.test.ts`.
**Interfaces:** Produces `RepoChange`, `RepoSource`, `class GitCloneSource implements RepoSource` (`constructor(cfg: { ref: string; branch?: string; subpath?: string; cacheDir?: string })`).

- [ ] **Step 1: Failing test (builds a real temp git repo)**

```ts
// append to ts/tests/repo.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCloneSource } from "../connectors/reposource.js";

describe("GitCloneSource (real git)", () => {
  const root = mkdtempSync(join(tmpdir(), "eil-git-"));
  const origin = join(root, "origin");
  const cache = join(root, "cache");
  const g = (args: string[]) => execFileSync("git", ["-C", origin, ...args], { encoding: "utf-8" });
  let c1 = "";
  beforeAll(() => {
    mkdirSync(join(origin, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
    writeFileSync(join(origin, "src/a.ts"), "l1\nl2\n");
    writeFileSync(join(origin, "src/b.ts"), "keep\n");
    g(["add", "-A"]); g(["commit", "-qm", "c1"]);
    c1 = g(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(origin, "src/a.ts"), "l1\nl2\nl3\n");
    rmSync(join(origin, "src/b.ts"));
    writeFileSync(join(origin, "src/c.ts"), "new\n");
    g(["add", "-A"]); g(["commit", "-qm", "c2"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("clones, lists, reads, and diffs A/M/D", async () => {
    const src = new GitCloneSource({ ref: origin, branch: "main", cacheDir: cache });
    const head = await src.headSha();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const files: string[] = [];
    for await (const p of src.listFiles()) files.push(p);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/c.ts");
    expect(files).not.toContain("src/b.ts"); // deleted at head
    expect(await src.readFile("src/a.ts")).toBe("l1\nl2\nl3\n");
    const changes: Record<string, string> = {};
    for await (const ch of src.changedSince(c1)) changes[ch.path] = ch.status;
    expect(changes["src/a.ts"]).toBe("M");
    expect(changes["src/b.ts"]).toBe("D");
    expect(changes["src/c.ts"]).toBe("A");
    await src.dispose();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
// ts/connectors/reposource.ts
/** Pluggable repo content sources for code ingestion. GitCloneSource uses a
 *  treeless partial clone (cheap history + on-demand blobs) for huge repos. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface RepoChange { path: string; status: "A" | "M" | "D" }
export interface RepoSource {
  headSha(): Promise<string>;
  listFiles(): AsyncGenerator<string>;
  changedSince(sha: string): AsyncGenerator<RepoChange>;
  readFile(path: string): Promise<string>;
  blobUrl(path: string): string | null;
  dispose(): Promise<void>;
}

export class GitCloneSource implements RepoSource {
  private readonly ref: string;
  private readonly branch: string;
  private readonly subpath?: string;
  private readonly dir: string;
  private ready: Promise<void> | null = null;
  constructor(cfg: { ref: string; branch?: string; subpath?: string; cacheDir?: string }) {
    this.ref = cfg.ref;
    this.branch = cfg.branch ?? "main";
    this.subpath = cfg.subpath;
    const base = cfg.cacheDir ?? process.env.EIL_REPO_CACHE ?? ".eil-repos";
    this.dir = cfg.cacheDir ? cfg.cacheDir : join(base, this.ref.replace(/[^\w.-]+/g, "_"));
  }
  private async git(args: string[]): Promise<string> {
    const { stdout } = await run("git", ["-C", this.dir, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }
  private async ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        if (!existsSync(join(this.dir, ".git"))) {
          await run("git", ["clone", "--filter=blob:none", "--single-branch",
            "--branch", this.branch, this.ref, this.dir], { maxBuffer: 64 * 1024 * 1024 });
        } else {
          await this.git(["fetch", "--quiet", "origin", this.branch]);
          await this.git(["reset", "--quiet", "--hard", `origin/${this.branch}`]);
        }
      })();
    }
    return this.ready;
  }
  async headSha(): Promise<string> {
    await this.ensure();
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }
  async *listFiles(): AsyncGenerator<string> {
    await this.ensure();
    const out = await this.git(["ls-files", ...(this.subpath ? ["--", this.subpath] : [])]);
    for (const line of out.split("\n")) if (line) yield line;
  }
  async *changedSince(sha: string): AsyncGenerator<RepoChange> {
    await this.ensure();
    const out = await this.git(["diff", "--name-status", sha, "HEAD",
      ...(this.subpath ? ["--", this.subpath] : [])]);
    for (const line of out.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      const code = parts[0]![0]!;
      if ((code === "R" || code === "C") && parts.length >= 3) {
        yield { path: parts[1]!, status: "D" };
        yield { path: parts[2]!, status: "A" };
      } else if (code === "A" || code === "M" || code === "D") {
        yield { path: parts[1]!, status: code };
      }
    }
  }
  async readFile(path: string): Promise<string> {
    await this.ensure();
    return this.git(["show", `HEAD:${path}`]);
  }
  blobUrl(path: string): string | null {
    const m = this.ref.replace(/\.git$/, "").match(/^https?:\/\/[^/]+\/(.+)$/);
    return m ? `${this.ref.replace(/\.git$/, "")}/browse/${path}?at=${this.branch}` : null;
  }
  async dispose(): Promise<void> {} // persistent cache
}
```

- [ ] **Step 4: Run → pass; typecheck/lint.**

- [ ] **Step 5: Commit** `git add ts/connectors/reposource.ts ts/tests/repo.test.ts && git commit -m "repo: RepoSource interface + GitCloneSource (partial clone, git-diff incremental)"`

---

### Task 5: BitbucketApiSource (mock-fetch test)

**Files:** Modify `ts/connectors/reposource.ts`; Test `ts/tests/repo.test.ts`.
**Interfaces:** Produces `class BitbucketApiSource implements RepoSource` (`constructor(cfg: { ref: string; branch?: string; subpath?: string }, fetcher?)`).

- [ ] **Step 1: Failing test**

```ts
// append to ts/tests/repo.test.ts
import type { Fetcher } from "../connectors/auth.js";
import { BitbucketApiSource } from "../connectors/reposource.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("BitbucketApiSource (mock)", () => {
  it("resolves head, lists, diffs, reads, and links", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      const u = String(url); calls.push(u);
      if (u.includes("/commits")) return json({ values: [{ id: "abc123" }] });
      if (u.includes("/files")) return json({ values: ["src/a.ts", "src/b.ts"], isLastPage: true });
      if (u.includes("/compare/changes")) return json({ values: [
        { path: { toString: "src/a.ts" }, type: "MODIFY" },
        { path: { toString: "src/b.ts" }, type: "DELETE" }], isLastPage: true });
      if (u.includes("/raw/")) return new Response("file contents", { status: 200 });
      return json({});
    };
    const s = new BitbucketApiSource({ ref: "PAY/retry", branch: "main" }, fetcher);
    expect(await s.headSha()).toBe("abc123");
    const files = []; for await (const p of s.listFiles()) files.push(p);
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    const changes: Record<string, string> = {};
    for await (const ch of s.changedSince("old")) changes[ch.path] = ch.status;
    expect(changes).toEqual({ "src/a.ts": "M", "src/b.ts": "D" });
    expect(await s.readFile("src/a.ts")).toBe("file contents");
    expect(s.blobUrl("src/a.ts")).toContain("/projects/PAY/repos/retry/browse/src/a.ts");
  });
});
```
(Note: `BitbucketApiSource` needs `EIL_BITBUCKET_URL`/`TOKEN` for `makeClient`; the test must set them in a `beforeAll`/inline and clean up, OR pass a baseUrl/token through the ctor. Implementers: wire the ctor to accept `makeClient("BITBUCKET", baseUrl?, token?, fetcher)` like the other connectors so the test injects a fake fetcher without real env — mirror `JiraClient`'s constructor signature.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — append to `ts/connectors/reposource.ts`:

```ts
import { type DcClient, type Fetcher, getJson, makeClient } from "./auth.js";

export class BitbucketApiSource implements RepoSource {
  private readonly client: DcClient;
  private readonly project: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly subpath: string;
  private head: string | null = null;
  constructor(cfg: { ref: string; branch?: string; subpath?: string; baseUrl?: string; token?: string }, fetcher?: Fetcher) {
    const [project, repo] = cfg.ref.split("/");
    this.project = project!; this.repo = repo!;
    this.branch = cfg.branch ?? "main";
    this.subpath = cfg.subpath ?? "";
    this.client = makeClient("BITBUCKET", cfg.baseUrl, cfg.token, fetcher);
  }
  private base(): string { return `/rest/api/1.0/projects/${this.project}/repos/${this.repo}`; }
  async headSha(): Promise<string> {
    const d = await getJson(this.client, `${this.base()}/commits`, { until: this.branch, limit: 1 });
    this.head = d.values?.[0]?.id ?? "";
    return this.head!;
  }
  async *listFiles(): AsyncGenerator<string> {
    const at = this.head ?? (await this.headSha());
    let start = 0;
    for (;;) {
      const d = await getJson(this.client, `${this.base()}/files/${this.subpath}`, { at, start, limit: 1000 });
      for (const p of d.values ?? []) yield this.subpath ? `${this.subpath.replace(/\/$/, "")}/${p}` : p;
      if (d.isLastPage !== false) return;
      start = d.nextPageStart ?? start + (d.values?.length ?? 0);
    }
  }
  async *changedSince(sha: string): AsyncGenerator<RepoChange> {
    const to = this.head ?? (await this.headSha());
    const map: Record<string, "A" | "M" | "D"> = { ADD: "A", MODIFY: "M", DELETE: "D", COPY: "A", MOVE: "M" };
    let start = 0;
    for (;;) {
      const d = await getJson(this.client, `${this.base()}/compare/changes`, { from: sha, to, start, limit: 1000 });
      for (const c of d.values ?? []) {
        const p = typeof c.path === "string" ? c.path : c.path?.toString;
        const st = map[c.type as string];
        if (p && st) yield { path: p, status: st };
      }
      if (d.isLastPage !== false) return;
      start = d.nextPageStart ?? start + (d.values?.length ?? 0);
    }
  }
  async readFile(path: string): Promise<string> {
    const at = this.head ?? (await this.headSha());
    const res = await this.client.fetcher(
      new URL(`${this.client.baseUrl}${this.base()}/raw/${path}?at=${at}`),
      { headers: this.client.headers },
    );
    if (!res.ok) throw new Error(`raw ${path} -> ${res.status}`);
    return res.text();
  }
  blobUrl(path: string): string | null {
    return `${this.client.baseUrl}${this.base()}/browse/${path}?at=${this.branch}`;
  }
  async dispose(): Promise<void> {}
}
```

- [ ] **Step 4: Run → pass; typecheck/lint.**

- [ ] **Step 5: Commit** `git add ts/connectors/reposource.ts ts/tests/repo.test.ts && git commit -m "repo: BitbucketApiSource (files/compare/raw, no clone)"`

---

### Task 6: Orchestrator ingestRepo + tombstone (PGlite + fake source)

**Files:** Modify `ts/ingest/pipeline.ts`; Test `ts/tests/repo.test.ts`.
**Interfaces:** Consumes `RepoSource`,`RepoFilter`,`normalizeCode`,`upsertDocument`,`getCursor`/`setCursor`. Produces `ingestRepo(source: RepoSource, key: string, subpath: string | undefined, filter: RepoFilter, tenant: string): Promise<{ upserted: number; deleted: number; skipped: number }>`.

- [ ] **Step 1: Failing test**

```ts
// append to ts/tests/repo.test.ts (own PGlite DB)
describe("ingestRepo orchestration", () => {
  const dir = mkdtempSync(join(tmpdir(), "eil-repo-"));
  beforeAll(async () => {
    process.env.EIL_DATABASE_URL = `pglite://${dir}`;
    const { connect, migrate } = await import("../db.js");
    const c = await connect(); await migrate(c); await c.end();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function fakeSource(head: string, files: Record<string, string>, changes?: RepoChange[]): RepoSource {
    return {
      headSha: async () => head,
      async *listFiles() { for (const p of Object.keys(files)) yield p; },
      async *changedSince() { for (const ch of changes ?? []) yield ch; },
      readFile: async (p) => files[p] ?? "",
      blobUrl: () => null,
      dispose: async () => {},
    };
  }

  it("full ingest sets the per-repo cursor and upserts code docs; incremental applies A/M/D", async () => {
    const { ingestRepo } = await import("../ingest/pipeline.js");
    const { RepoFilter } = await import("../ingest/repofilter.js");
    const { connect } = await import("../db.js");
    const { getCursor } = await import("../store.js");
    const filter = new RepoFilter({ includes: ["**/*.ts"] });

    const full = await ingestRepo(fakeSource("sha1", { "src/a.ts": "l1\n", "src/skip.md": "x", "src/big.ts": "\0" }),
      "org/repo", undefined, filter, "default");
    expect(full.upserted).toBe(1);            // a.ts; skip.md not-included; big.ts binary
    expect(full.skipped).toBeGreaterThanOrEqual(2);
    const c = await connect();
    try {
      expect(await getCursor(c, "code:org/repo")).toBe("sha1");
      const doc = await c.query("SELECT source FROM documents WHERE id = 'code:org/repo:src/a.ts'");
      expect(doc.rows[0].source).toBe("code");

      const inc = await ingestRepo(
        fakeSource("sha2", { "src/a.ts": "l1\nl2\n", "src/new.ts": "n\n" },
          [{ path: "src/a.ts", status: "M" }, { path: "src/new.ts", status: "A" }, { path: "src/a.ts", status: "D" }]),
        "org/repo", undefined, filter, "default");
      // note: contrived changes include a D for a.ts last -> ends deleted
      expect(await getCursor(c, "code:org/repo")).toBe("sha2");
    } finally { await c.end(); }
  });
});
```
(Implementers: adjust the incremental assertion to the deterministic outcome of your change-application order — process changes in listed order; a later `D` tombstones. Keep the test asserting cursor advance + at least one upsert + one tombstone reflected in `documents`.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — append to `ts/ingest/pipeline.ts` (consolidate imports):

```ts
import type { RepoChange, RepoSource } from "../connectors/reposource.js";
import { normalizeCode } from "./code.js";
import type { RepoFilter } from "./repofilter.js";
import { setCursor } from "../store.js";

async function tombstone(client: Db, id: string, tenant: string): Promise<void> {
  await client.query("DELETE FROM documents WHERE id = $1 AND tenant = $2", [id, tenant]);
}

export async function ingestRepo(
  source: RepoSource, key: string, subpath: string | undefined,
  filter: RepoFilter, tenant: string,
): Promise<{ upserted: number; deleted: number; skipped: number }> {
  const { upsertDocument, getCursor } = await import("../store.js");
  const cursorKey = `code:${key}${subpath ? `:${subpath}` : ""}`;
  const client = await connect();
  const out = { upserted: 0, deleted: 0, skipped: 0 };
  try {
    const head = await source.headSha();
    const cursor = await getCursor(client, cursorKey);
    if (cursor === head) { console.log(`${cursorKey}: up to date (${head})`); return out; }

    const ingestOne = async (path: string) => {
      if (!filter.acceptPath(path)) { out.skipped++; return; }
      const content = await source.readFile(path);
      if (!filter.acceptContent(content)) { out.skipped++; console.log(`  skip ${path} (binary/size)`); return; }
      if (await upsertDocument(client, normalizeCode(key, path, content, source.blobUrl(path), tenant))) {
        out.upserted++; console.log(`  ~ ${path}`);
      }
    };

    let changes: RepoChange[] | null = null;
    if (cursor) {
      try { changes = []; for await (const ch of source.changedSince(cursor)) changes.push(ch); }
      catch { changes = null; } // unreachable sha -> full resync
    }
    if (changes) {
      for (const ch of changes) {
        if (ch.status === "D") { await tombstone(client, `code:${key}:${ch.path}`, tenant); out.deleted++; console.log(`  - ${ch.path}`); }
        else await ingestOne(ch.path);
      }
    } else {
      for await (const path of source.listFiles()) await ingestOne(path);
    }
    await setCursor(client, cursorKey, head);
    console.log(`${cursorKey}: ${out.upserted} upserted, ${out.deleted} deleted, ${out.skipped} skipped -> ${head}`);
  } finally { await client.end(); }
  await source.dispose();
  return out;
}
```

- [ ] **Step 4: Run → pass; full suite + typecheck/lint.**

- [ ] **Step 5: Commit** `git add ts/ingest/pipeline.ts ts/tests/repo.test.ts && git commit -m "repo: ingestRepo orchestrator (full + git-diff incremental, tombstone deletes, per-repo cursor)"`

---

### Task 7: CLI `eil ingest repo`

**Files:** Modify `ts/cli.ts`; Test `ts/tests/repo.test.ts`.
**Interfaces:** Consumes `detectSource`,`repoKey`,`GitCloneSource`,`BitbucketApiSource`,`RepoFilter`,`ingestRepo`.

- [ ] **Step 1: Add the command** — in `ts/cli.ts` under the `ingest` group:

```ts
ingest
  .command("repo <refs...>")
  .description("Ingest one or more git repos (git clone or Bitbucket API) as code docs")
  .option("--source <kind>", "git | bitbucket (default: auto-detect per ref)")
  .option("--branch <b>", "branch", "main")
  .option("--subpath <p>", "restrict to a subdirectory")
  .option("--include <glob...>", "only paths matching (repeatable)")
  .option("--exclude <glob...>", "skip paths matching (repeatable)")
  .option("--name <key>", "override the repo key (else derived from the ref)")
  .option("--tenant <tenant>", "tenant", "default")
  .action(async (refs: string[], opts) => {
    const { detectSource, repoKey } = await import("./ingest/code.js");
    const { GitCloneSource, BitbucketApiSource } = await import("./connectors/reposource.js");
    const { RepoFilter } = await import("./ingest/repofilter.js");
    const { ingestRepo } = await import("./ingest/pipeline.js");
    const filter = new RepoFilter({ includes: opts.include, excludes: opts.exclude });
    for (const ref of refs) {
      const kind = opts.source ?? detectSource(ref);
      const key = repoKey(ref, opts.name);
      const cfg = { ref, branch: opts.branch, subpath: opts.subpath };
      const source =
        kind === "bitbucket"
          ? liveClient(() => new BitbucketApiSource(cfg), "EIL_BITBUCKET_URL and EIL_BITBUCKET_TOKEN")
          : new GitCloneSource(cfg);
      console.log(`ingest ${kind} ${key} (${ref})`);
      await ingestRepo(source, key, opts.subpath, filter, opts.tenant);
    }
  });
```

- [ ] **Step 2: Add a CLI-parse test** (pure) — asserts `detectSource`/`repoKey` for the shapes the command will hand them (already covered in Task 3; add a multi-ref note if needed). Then a manual smoke:

```bash
pnpm typecheck && pnpm lint
# real end-to-end against a throwaway local git repo:
T=$(mktemp -d); git init -q -b main "$T"; git -C "$T" config user.email t@t; git -C "$T" config user.name t
mkdir -p "$T/src"; printf 'export const x=1\n' > "$T/src/a.ts"; git -C "$T" add -A; git -C "$T" commit -qm c1
D=.eil-repo; EIL_DATABASE_URL=pglite://$D pnpm -s eil db migrate >/dev/null
EIL_DATABASE_URL=pglite://$D pnpm -s eil ingest repo "$T" --include '**/*.ts'
EIL_DATABASE_URL=pglite://$D pnpm -s eil search "const x" | grep -q "code:" && echo "repo search OK"
rm -rf "$D" "$T"
```
Expected: ingest prints `1 upserted`, search finds a `code:` doc.

- [ ] **Step 3: Run the smoke → passes; full suite green.**

- [ ] **Step 4: Commit** `git add ts/cli.ts ts/tests/repo.test.ts && git commit -m "cli: eil ingest repo (multi-ref, git/bitbucket auto-detect, globs/subpath/branch)"`

---

### Task 8: Documentation

**Files:** Modify `README.md`.

- [ ] **Step 1** — add a "Repo / code ingestion" subsection (after "Selective ingestion") documenting `eil ingest repo`, the granularity knobs, git-vs-bitbucket sources, incremental+deletions, and that code becomes FTS+semantic searchable (`source:"code"`). Keep fences balanced (`grep -c '```'` even).
- [ ] **Step 2** — add a Status line: `- [x] Repo/code ingestion — git clone or Bitbucket API, subpath/branch/globs, code-aware chunking, per-repo commit-SHA incremental with deletions`.
- [ ] **Step 3** — Commit `git add README.md && git commit -m "README: repo/code ingestion"`.

---

## Self-Review

**Spec coverage:** RepoSource+2 impls (T4,T5); granularity repo/subpath/branch/globs (T2 filter, T4/T5 subpath, T7 flags); code chunker (T1); per-repo SHA cursor + diff + deletions (T4 changedSince, T6 orchestrator); no migration (source=code, cursor reuse); ACL fail-closed (T3); binary/size/glob skip logged (T2,T6); docs (T8). ✓

**Placeholder scan:** none — full code per code step; verify steps have commands + expected output. Two implementer-latitude notes (glob `**` simplification; bitbucket ctor mirrors JiraClient) are explicit, not placeholders.

**Type consistency:** `RepoSource`/`RepoChange`, `GitCloneSource`/`BitbucketApiSource`, `RepoFilter.acceptPath/acceptContent`, `normalizeCode`/`repoKey`/`detectSource`, `ingestRepo(...)`, `chunkCode`/`chunk` dispatch — consistent across tasks and call sites. Cursor key `code:<key>[:<subpath>]` identical in T6 and used by T7.
