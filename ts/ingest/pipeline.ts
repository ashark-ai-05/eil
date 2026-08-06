/** Shared ingest pipeline: per-doc upsert with cursor bookkeeping, and the
 *  full-listing reconcile. Extracted from cli.ts so orchestration is testable. */

import type { RepoChange, RepoSource } from "../connectors/reposource.js";
import type { Scope } from "../connectors/scope.js";
import { cursorKey, predicate } from "../connectors/scope.js";
import type { CanonicalDoc } from "../contracts/models.js";
import type { Db, Tx } from "../db.js";
import { connect } from "../db.js";
import { getCursor, setCursor } from "../store.js";
import { normalizeCode } from "./code.js";
import type { ConfluencePage } from "./confluence.js";
import type { JiraIssue } from "./jira.js";
import type { RepoFilter } from "./repofilter.js";

interface IngestOutcome {
  seen: number;
  changed: number;
  /** HARD failures: the document did not land. Holds the cursor. */
  failed: number;
  /** Related work that did not land while the document DID. Never holds the cursor. */
  healthDebt: number;
  target: string | null;
}

/**
 * One unit of ingestion: a document, plus optional related state that must
 * commit with it.
 *
 * Deliberately source-NEUTRAL. The runner knows only that some related state
 * exists and must share the document's commit boundary; what that state is —
 * attachments, anything later — is the caller's business, closed over inside
 * the hook. Putting source-specific fields here would leak connector policy
 * into shared orchestration.
 */
export interface IngestItem {
  doc: CanonicalDoc;
  /**
   * Work that was ATTEMPTED and failed before this item reached the runner,
   * without preventing the document itself from being correct.
   *
   * This is the second failure axis, and it exists because the first one drives
   * two unrelated decisions at once. `failed` both marks the run unhealthy AND
   * pins `retryFrom` so the next run re-fetches from that document. That is
   * right for a document that did not land. It is catastrophic for related work
   * that can never succeed — an oversized attachment would hold the watermark
   * forever, re-fetching the same window every run and advancing nothing, which
   * is exactly the livelock the fatal-error handling above was written to
   * eliminate.
   *
   * So debt counts toward health and toward the persisted failure count, and
   * never toward the cursor.
   */
  healthDebt?: number;
  /**
   * Related state, persisted INSIDE the document's transaction.
   *
   * Runs even when the document's text is unchanged: related state has its own
   * lifecycle and can move while the parent hash does not. A throw here is a
   * HARD failure — the document and the related state roll back together, and
   * the cursor holds — because a parent committed without the state that was
   * supposed to accompany it is exactly the half-applied write the single
   * boundary exists to prevent.
   */
  persistRelated?: (tx: Tx) => Promise<void>;
}

const asItem = (v: CanonicalDoc | IngestItem): IngestItem => ("doc" in v ? v : { doc: v });

/** Debt must be a real count. A NaN would silently vanish from every sum. */
function validDebt(n: number | undefined, id: string): number {
  if (n === undefined) return 0;
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`ingest item ${id}: healthDebt must be a non-negative integer, got ${n}`);
  return n;
}

export async function ingestDocs(
  source: string,
  docs: AsyncIterable<CanonicalDoc | IngestItem> | Iterable<CanonicalDoc | IngestItem>,
  cursorOf?: (doc: CanonicalDoc) => string | null,
  tenant = "default",
): Promise<void> {
  const { setCursor, upsertDocumentInTx } = await import("../store.js");
  const { withTransaction } = await import("../db.js");
  const client = await connect();
  const outcome: IngestOutcome = { seen: 0, changed: 0, failed: 0, healthDebt: 0, target: null };
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
    for await (const entry of docs) {
      const item = asItem(entry);
      const doc = item.doc;
      outcome.seen += 1;
      const value = cursorOf ? cursorOf(doc) : null;
      let debt = 0;
      try {
        // Validated INSIDE the per-item guard. Outside it, a malformed count
        // would escape as a fatal listing error and abort every remaining
        // document — punishing the whole run for one caller's bad field.
        debt = validDebt(item.healthDebt, doc.id);
        // ONE transaction owns the document and everything that must land with
        // it. The hook runs unconditionally, not only when the text changed:
        // related state moves independently of the parent hash.
        const changed = await withTransaction(client, async (tx) => {
          const didChange = await upsertDocumentInTx(tx, doc);
          await item.persistRelated?.(tx);
          return didChange;
        });
        if (changed) {
          outcome.changed += 1;
          console.log(`  ~ ${doc.id}`);
        }
      } catch (err: any) {
        outcome.failed += 1;
        console.log(`  ! failed (${err.constructor?.name ?? "Error"}): ${err.message}`);
        if (value && (retryFrom === null || value < retryFrom)) retryFrom = value;
        continue;
      }
      // Debt is counted only once the document actually landed, and it does NOT
      // touch retryFrom — the watermark still advances past a document that is
      // itself correct.
      outcome.healthDebt += debt;
      if (debt > 0) console.log(`  · ${doc.id}: ${debt} related item(s) did not land`);
      if (value && (latest === null || value > latest)) latest = value;
    }
  } catch (err: any) {
    fatal = err;
    console.log(`  ! listing aborted (${err.constructor?.name ?? "Error"}): ${err.message}`);
  } finally {
    try {
      outcome.target = retryFrom ?? latest;
      if (outcome.target)
        await setCursor(client, source, outcome.target, tenant, {
          // A run that aborted mid-listing, or that failed to upsert anything it
          // saw, has not SUCCEEDED — even though it may legitimately advance the
          // cursor past the documents that did land. Only a clean pass resets
          // the freshness clock.
          // Debt makes a run unhealthy exactly as a hard failure does — work
          // that should have landed did not. What it must never do is pin the
          // cursor, which is why it is absent from `retryFrom` entirely.
          succeeded: !fatal && outcome.failed === 0 && outcome.healthDebt === 0,
          // Recorded even when the run is already marked unsuccessful: "3
          // documents did not land" and "the run failed" are different facts,
          // and only the first says how much of the corpus is missing.
          itemFailures: outcome.failed + outcome.healthDebt,
          ...(fatal ? { error: String((fatal as Error)?.message ?? fatal).slice(0, 500) } : {}),
        });
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
  // Reported separately and never as "held": saying the cursor was held when it
  // advanced would describe the opposite of what happened, and an operator
  // reading it would go looking for a stuck connector that is not stuck.
  if (outcome.healthDebt > 0)
    summary += `, ${outcome.healthDebt} related item(s) missing (cursor advanced)`;
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

/**
 * These two are now thin adapters over the registry.
 *
 * They were the same thirty lines twice — same cursor read, same generator
 * wrapper, same ingestDocs call — differing only in which normalizer they
 * imported and which method fetched one item. The protocol lives once in
 * `ingestScope`; the per-source differences live in the specs.
 *
 * Kept as named functions rather than deleted because they are the CLI's and
 * the tests' entry points, and collapsing the duplication is a separate concern
 * from renaming the callers.
 */
export async function ingestConfluenceScope(
  conf: ConfluenceLike,
  scope: Scope,
  tenant: string,
): Promise<void> {
  const { confluenceSpec, ingestScope } = await import("./registry.js");
  await ingestScope(confluenceSpec, conf as never, scope, tenant);
}

export async function ingestJiraScope(jira: JiraLike, scope: Scope, tenant: string): Promise<void> {
  const { jiraSpec, ingestScope } = await import("./registry.js");
  await ingestScope(jiraSpec, jira as never, scope, tenant);
}

async function tombstone(client: Db, id: string, tenant: string): Promise<void> {
  // Routed through the lifecycle helper rather than deleting directly, so the
  // "code documents never carry artifacts" contract is enforced where it is
  // relied on instead of being a comment that stops being true silently.
  const { hardDeleteDocument } = await import("../purge.js");
  await hardDeleteDocument(client, tenant, id);
}

export async function ingestRepo(
  source: RepoSource,
  key: string,
  subpath: string | undefined,
  filter: RepoFilter,
  tenant: string,
  /** Groups granted read on every file. Empty = owner-only, and fail-closed. */
  aclGroups: readonly string[] = [],
): Promise<{ upserted: number; deleted: number; skipped: number; failed: number }> {
  const { upsertDocument } = await import("../store.js");
  const ckey = `code:${key}${subpath ? `:${subpath}` : ""}`;
  const client = await connect();
  // `skipped` and `failed` are deliberately separate counters. A path excluded
  // by the filter, or a binary blob, is a policy decision working correctly —
  // every real repository skips vendored trees and images. A file the source
  // could not READ is a document that should be in the corpus and is not.
  // Reporting them as one number would mark every repository permanently
  // incomplete, which is the same as reporting nothing at all.
  const out = { upserted: 0, deleted: 0, skipped: 0, failed: 0 };
  try {
    const head = await source.headSha();
    const cursor = await getCursor(client, ckey, tenant);
    if (cursor === head) {
      console.log(`${ckey}: up to date (${head})`);
      return out;
    }

    // One git-log pass for the whole repo, resolved before the file loop, so a
    // date lookup below is a Map hit rather than a subprocess per file.
    // Best-effort: a source that cannot answer cheaply (the Bitbucket API one)
    // returns null and its documents keep a null updated_at, as before.
    let fileDates: Map<string, string> | null = null;
    try {
      fileDates = (await source.lastModified?.()) ?? null;
    } catch (err: any) {
      console.log(`  (file dates unavailable: ${err.message})`);
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
        // A read failure is NOT a skip. The file is in the repository, it
        // belongs in the corpus, and it is missing — so it is counted where a
        // reader of the coverage report will see it.
        out.failed++;
        console.log(`  ! ${path} (read failed: ${err.message})`);
        return;
      }
      if (!filter.acceptContent(content)) {
        out.skipped++;
        console.log(`  skip ${path} (binary/size)`);
        return;
      }
      const doc = normalizeCode(
        key,
        path,
        content,
        source.blobUrl(path),
        tenant,
        head,
        fileDates?.get(path) ?? null,
        aclGroups,
      );
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
    // The full-listing fallback below re-upserts every file currently present
    // and reconciles the bounded repo/subpath inventory. Keep this comment in
    // sync with the reconcileCodeRepo() call below.
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
    // A run that could not read some of the files it listed has not fully
    // succeeded, however many others landed. Before this, the default
    // `{succeeded: true}` recorded a fresh `last_success_at` and a zero failure
    // count for exactly that run, so the corpus reported itself current while
    // documents were missing from it.
    //
    // The cursor is HELD at its prior value when anything failed, which is the
    // part that makes the item-failure count truthful rather than decorative.
    // Advancing to `head` puts the unreadable file BEHIND the cursor: it did not
    // change, so no later incremental scan ever lists it again. The next run
    // triggered by some unrelated commit then reads everything it sees, records
    // `itemFailures: 0`, and restores `complete: true` while that document stays
    // permanently absent. A per-run count is only honest if the failed items are
    // guaranteed to be in the next run's scan, and only holding the cursor
    // guarantees that. This mirrors `retryFrom` in ingestDocs above.
    //
    // Holding at null on a first full run is deliberate and is not a lost
    // cursor: with no earlier position to fall back to, "never advanced" is what
    // forces the next run to re-list the whole repository, which necessarily
    // includes the files that failed.
    const advanceTo = out.failed === 0 ? head : cursor;
    await setCursor(client, ckey, advanceTo, tenant, {
      succeeded: out.failed === 0,
      itemFailures: out.failed,
    });
    let line = `${ckey}: ${out.upserted} upserted, ${out.deleted} deleted, ${out.skipped} skipped`;
    if (out.failed > 0) line += `, ${out.failed} FAILED`;
    console.log(`${line} -> ${head}`);
  } finally {
    await client.end();
    await source.dispose();
  }
  return out;
}
