/** Shared ingest pipeline: per-doc upsert with cursor bookkeeping, and the
 *  full-listing reconcile. Extracted from cli.ts so orchestration is testable. */

import type { CanonicalDoc } from "../contracts/models.js";
import { connect } from "../db.js";

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
