/** Shared ingest pipeline: per-doc upsert with cursor bookkeeping, and the
 *  full-listing reconcile. Extracted from cli.ts so orchestration is testable. */

import type { RepoChange, RepoSource } from "../connectors/reposource.js";
import type { Scope } from "../connectors/scope.js";
import { cursorKey, predicate } from "../connectors/scope.js";
import type { CanonicalDoc } from "../contracts/models.js";
import type { Db } from "../db.js";
import { connect } from "../db.js";
import { getCursor, setCursor } from "../store.js";
import { normalizeCode } from "./code.js";
import type { ConfluencePage } from "./confluence.js";
import type { JiraIssue } from "./jira.js";
import type { RepoFilter } from "./repofilter.js";

interface IngestOutcome {
  seen: number;
  changed: number;
  failed: number;
  target: string | null;
}

export async function ingestDocs(
  source: string,
  docs: AsyncIterable<CanonicalDoc> | Iterable<CanonicalDoc>,
  cursorOf?: (doc: CanonicalDoc) => string | null,
  tenant = "default",
): Promise<void> {
  const { setCursor, upsertDocument } = await import("../store.js");
  const client = await connect();
  const outcome: IngestOutcome = { seen: 0, changed: 0, failed: 0, target: null };
  let latest: string | null = null;
  let retryFrom: string | null = null;
  // A failure thrown by the GENERATOR — i.e. any HTTP error inside a
  // connector's pagination loop — escapes `for await`. Previously it escaped
  // past setCursor too, so a 429 on page 40 of 200 discarded the cursor advance
  // earned by pages 1-39. Combined with the absence of any retry, a source that
  // rate-limits at the same offset produced an unbreakable livelock: every run
  // re-fetched the same prefix and advanced nothing, forever.
  //
  // Persisting progress is therefore in `finally`, and the generator's error is
  // captured rather than allowed to unwind past it. It is still re-thrown — the
  // operator must see the failure — but only after the cursor is safe.
  let fatal: unknown;
  try {
    for await (const doc of docs) {
      outcome.seen += 1;
      const value = cursorOf ? cursorOf(doc) : null;
      try {
        if (await upsertDocument(client, doc)) {
          outcome.changed += 1;
          console.log(`  ~ ${doc.id}`);
        }
      } catch (err: any) {
        outcome.failed += 1;
        console.log(`  ! failed (${err.constructor?.name ?? "Error"}): ${err.message}`);
        if (value && (retryFrom === null || value < retryFrom)) retryFrom = value;
        continue;
      }
      if (value && (latest === null || value > latest)) latest = value;
    }
  } catch (err: any) {
    fatal = err;
    console.log(`  ! listing aborted (${err.constructor?.name ?? "Error"}): ${err.message}`);
  } finally {
    try {
      outcome.target = retryFrom ?? latest;
      if (outcome.target) await setCursor(client, source, outcome.target, tenant);
    } finally {
      await client.end();
    }
  }
  if (fatal) {
    // The cursor is committed at the last document that actually landed, so the
    // next run resumes from there instead of restarting the scan.
    let msg = `${outcome.seen} seen, ${outcome.changed} changed`;
    if (outcome.target) msg += `, cursor -> ${outcome.target} (progress kept)`;
    console.log(msg);
    throw fatal;
  }
  let summary = `${outcome.seen} seen, ${outcome.changed} changed`;
  if (outcome.failed > 0)
    summary += `, ${outcome.failed} FAILED (cursor held at ${outcome.target})`;
  else if (latest) summary += `, cursor -> ${latest}`;
  console.log(summary);
}

export async function runReconcile(
  source: string,
  listIds: () => Promise<{ ids: string[]; complete: boolean }>,
  tenant: string,
): Promise<void> {
  console.log(`reconcile: fetching full ${source} id listing...`);
  const listing = await listIds();
  const { reconcile } = await import("../store.js");
  const client = await connect();
  try {
    const outcome = await reconcile(client, source, listing, tenant);
    for (const id of outcome.tombstoned)
      console.log(`  - ${id} (quarantined after source removal)`);
    console.log(
      `reconcile: ${listing.ids.length} listed (${outcome.status}), ${outcome.tombstoned.length} quarantined`,
    );
  } finally {
    await client.end();
  }
}

export interface ConfluenceLike {
  updatedSince(cursor: string | null, scope?: string): AsyncGenerator<ConfluencePage>;
  getPage(id: string): Promise<ConfluencePage>;
  descendants(id: string): AsyncGenerator<ConfluencePage>;
}

export interface JiraLike {
  updatedSince(cursor: string | null, scope?: string): AsyncGenerator<JiraIssue>;
  getIssue(key: string): Promise<JiraIssue>;
}

export async function ingestConfluenceScope(
  conf: ConfluenceLike,
  scope: Scope,
  tenant: string,
): Promise<void> {
  const { normalize } = await import("./confluence.js");
  if (scope.kind === "pages") {
    const ids = scope.ids;
    const withDesc = scope.withDescendants;
    console.log(`scope confluence:pages [${ids.join(", ")}]${withDesc ? " +descendants" : ""}`);
    const docs = (async function* () {
      for (const id of ids) {
        yield normalize(await conf.getPage(id), tenant);
        if (withDesc) for await (const p of conf.descendants(id)) yield normalize(p, tenant);
      }
    })();
    await ingestDocs("confluence", docs, undefined, tenant); // explicit fetch: no cursor
    return;
  }
  const key = cursorKey("confluence", scope);
  if (key === null) throw new Error(`unexpected non-cursor confluence scope: ${scope.kind}`);
  const client = await connect();
  const cursor = await getCursor(client, key, tenant);
  await client.end();
  console.log(`scope ${key} from cursor: ${cursor ?? "(beginning)"}`);
  const pred = predicate(scope) ?? undefined;
  const docs = (async function* () {
    for await (const p of conf.updatedSince(cursor, pred)) yield normalize(p, tenant);
  })();
  await ingestDocs(key, docs, (d) => d.updatedAt ?? null, tenant);
}

export async function ingestJiraScope(jira: JiraLike, scope: Scope, tenant: string): Promise<void> {
  const { normalize } = await import("./jira.js");
  if (scope.kind === "issues") {
    const keys = scope.keys;
    console.log(`scope jira:issues [${keys.join(", ")}]`);
    const docs = (async function* () {
      for (const k of keys) yield normalize(await jira.getIssue(k), tenant);
    })();
    await ingestDocs("jira", docs, undefined, tenant); // explicit fetch: no cursor
    return;
  }
  const key = cursorKey("jira", scope);
  if (key === null) throw new Error(`unexpected non-cursor jira scope: ${scope.kind}`);
  const client = await connect();
  const cursor = await getCursor(client, key, tenant);
  await client.end();
  console.log(`scope ${key} from cursor: ${cursor ?? "(beginning)"}`);
  const pred = predicate(scope) ?? undefined;
  const docs = (async function* () {
    for await (const i of jira.updatedSince(cursor, pred)) yield normalize(i, tenant);
  })();
  await ingestDocs(key, docs, (d) => d.updatedAt ?? null, tenant);
}

async function tombstone(client: Db, id: string, tenant: string): Promise<void> {
  await client.query("DELETE FROM documents WHERE id = $1 AND tenant = $2", [id, tenant]);
}

export async function ingestRepo(
  source: RepoSource,
  key: string,
  subpath: string | undefined,
  filter: RepoFilter,
  tenant: string,
): Promise<{ upserted: number; deleted: number; skipped: number }> {
  const { upsertDocument } = await import("../store.js");
  const ckey = `code:${key}${subpath ? `:${subpath}` : ""}`;
  const client = await connect();
  const out = { upserted: 0, deleted: 0, skipped: 0 };
  try {
    const head = await source.headSha();
    const cursor = await getCursor(client, ckey, tenant);
    if (cursor === head) {
      console.log(`${ckey}: up to date (${head})`);
      return out;
    }

    const ingestOne = async (path: string) => {
      if (!filter.acceptPath(path)) {
        out.skipped++;
        return;
      }
      // Isolate ONLY the read: a single huge/unreadable blob must not abort
      // the whole run (and thus never advance the cursor). A DB error from
      // upsertDocument below is intentionally NOT caught here — it should
      // still propagate and hold the cursor.
      let content: string;
      try {
        content = await source.readFile(path);
      } catch (err: any) {
        out.skipped++;
        console.log(`  skip ${path} (read failed: ${err.message})`);
        return;
      }
      if (!filter.acceptContent(content)) {
        out.skipped++;
        console.log(`  skip ${path} (binary/size)`);
        return;
      }
      const doc = normalizeCode(key, path, content, source.blobUrl(path), tenant, head);
      if (await upsertDocument(client, doc)) {
        await (await import("../store.js")).replaceCodeIndex(client, doc, key, path, head);
        out.upserted++;
        console.log(`  ~ ${path}`);
      }
    };

    let changes: RepoChange[] | null = null;
    if (cursor) {
      try {
        changes = [];
        for await (const ch of source.changedSince(cursor)) changes.push(ch);
      } catch {
        changes = null; // unreachable sha -> full resync
      }
    }
    // NOTE: the full-listing fallback below (changes === null) re-upserts
    // every file currently present, but it does NOT tombstone files that
    // were deleted during the missed commit range — there is no reconcile
    // pass for code (unlike Confluence/Jira/Obsidian; deliberate non-goal).
    // Those stale docs linger in the catalog until their path is re-touched
    // by a future commit.
    if (changes) {
      for (const ch of changes) {
        if (ch.status === "D") {
          await tombstone(client, `code:${key}:${ch.path}`, tenant);
          out.deleted++;
          console.log(`  - ${ch.path}`);
        } else await ingestOne(ch.path);
      }
    } else {
      const listed: string[] = [];
      for await (const path of source.listFiles()) {
        listed.push(`code:${key}:${path}`);
        await ingestOne(path);
      }
      const removed = await (await import("../store.js")).reconcileCodeRepo(
        client,
        key,
        listed,
        tenant,
        subpath, // bound the tombstone to the subtree this run actually listed
      );
      out.deleted += removed.length;
      for (const id of removed) console.log(`  - ${id} (quarantined after full resync)`);
    }
    await setCursor(client, ckey, head, tenant);
    console.log(
      `${ckey}: ${out.upserted} upserted, ${out.deleted} deleted, ${out.skipped} skipped -> ${head}`,
    );
  } finally {
    await client.end();
    await source.dispose();
  }
  return out;
}
