/** Shared ingest pipeline: per-doc upsert with cursor bookkeeping, and the
 *  full-listing reconcile. Extracted from cli.ts so orchestration is testable. */

import type { Scope } from "../connectors/scope.js";
import { cursorKey, predicate } from "../connectors/scope.js";
import type { CanonicalDoc } from "../contracts/models.js";
import { connect } from "../db.js";
import type { ConfluencePage } from "../ingest/confluence.js";
import type { JiraIssue } from "../ingest/jira.js";
import { getCursor } from "../store.js";

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
): Promise<void> {
  const { setCursor, upsertDocument } = await import("../store.js");
  const client = await connect();
  const outcome: IngestOutcome = { seen: 0, changed: 0, failed: 0, target: null };
  let latest: string | null = null;
  let retryFrom: string | null = null;
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
    outcome.target = retryFrom ?? latest;
    if (outcome.target) await setCursor(client, source, outcome.target);
  } finally {
    await client.end();
  }
  let summary = `${outcome.seen} seen, ${outcome.changed} changed`;
  if (outcome.failed > 0)
    summary += `, ${outcome.failed} FAILED (cursor held at ${outcome.target})`;
  else if (latest) summary += `, cursor -> ${latest}`;
  console.log(summary);
}

export async function runReconcile(
  source: string,
  listIds: () => Promise<string[]>,
  tenant: string,
): Promise<void> {
  console.log(`reconcile: fetching full ${source} id listing...`);
  const present = await listIds();
  const { reconcile } = await import("../store.js");
  const client = await connect();
  try {
    const removed = await reconcile(client, source, present, tenant);
    for (const id of removed) console.log(`  - ${id} (deleted at source)`);
    console.log(`reconcile: ${present.length} present at source, ${removed.length} removed`);
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
  const { normalize } = await import("../ingest/confluence.js");
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
    await ingestDocs("confluence", docs); // explicit fetch: no cursor
    return;
  }
  const key = cursorKey("confluence", scope);
  if (key === null) throw new Error(`unexpected non-cursor confluence scope: ${scope.kind}`);
  const client = await connect();
  const cursor = await getCursor(client, key);
  await client.end();
  console.log(`scope ${key} from cursor: ${cursor ?? "(beginning)"}`);
  const pred = predicate(scope) ?? undefined;
  const docs = (async function* () {
    for await (const p of conf.updatedSince(cursor, pred)) yield normalize(p, tenant);
  })();
  await ingestDocs(key, docs, (d) => d.updatedAt ?? null);
}

export async function ingestJiraScope(jira: JiraLike, scope: Scope, tenant: string): Promise<void> {
  const { normalize } = await import("../ingest/jira.js");
  if (scope.kind === "issues") {
    const keys = scope.keys;
    console.log(`scope jira:issues [${keys.join(", ")}]`);
    const docs = (async function* () {
      for (const k of keys) yield normalize(await jira.getIssue(k), tenant);
    })();
    await ingestDocs("jira", docs); // explicit fetch: no cursor
    return;
  }
  const key = cursorKey("jira", scope);
  if (key === null) throw new Error(`unexpected non-cursor jira scope: ${scope.kind}`);
  const client = await connect();
  const cursor = await getCursor(client, key);
  await client.end();
  console.log(`scope ${key} from cursor: ${cursor ?? "(beginning)"}`);
  const pred = predicate(scope) ?? undefined;
  const docs = (async function* () {
    for await (const i of jira.updatedSince(cursor, pred)) yield normalize(i, tenant);
  })();
  await ingestDocs(key, docs, (d) => d.updatedAt ?? null);
}
