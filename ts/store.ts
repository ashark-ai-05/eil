/**
 * Catalog writes with the hash gate: unchanged content is a no-op.
 * Re-running a connector against an unchanged corpus writes nothing.
 */

import { userInfo } from "node:os";
import { type CanonicalDoc, chunkHash, contentHash, sha256 } from "./contracts/models.js";
import { chunk } from "./core/chunker.js";
import { codeTokens } from "./core/tokenize.js";
import type { Db } from "./db.js";
import { extractCodeIndex } from "./ingest/codeindex.js";
import { type SecretFinding, scanSecrets, unacceptedFindings } from "./ingest/secrets.js";

export async function getCursor(
  client: Db,
  source: string,
  tenant = "default",
): Promise<string | null> {
  const res = await client.query(
    "SELECT cursor FROM sync_cursors WHERE tenant = $1 AND source = $2",
    [tenant, source],
  );
  return res.rows[0]?.cursor ?? null;
}

/**
 * Advance a connector cursor.
 *
 * `succeeded` is not bookkeeping — it is what makes the staleness alert work.
 * `updated_at` means "we wrote this row" and is touched every run, including the
 * failure-hold path where the cursor VALUE is deliberately pinned.
 * `last_success_at` means "a document actually landed", and only that can answer
 * "has this connector silently died". Setting both unconditionally is what let a
 * connector failing every single document report itself perfectly fresh.
 */
export async function setCursor(
  client: Db,
  source: string,
  /** Null pins the connector at "never advanced", so the next run rescans from
   *  the beginning. That is the correct hold when a first full run lost files:
   *  there is no earlier position to fall back to. */
  cursor: string | null,
  tenant = "default",
  outcome: { succeeded: boolean; error?: string; itemFailures?: number } = { succeeded: true },
): Promise<void> {
  await client.query(
    "INSERT INTO sync_cursors (tenant, source, cursor, last_success_at, consecutive_failures," +
      " last_error, last_run_item_failures)" +
      " VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN 0 ELSE 1 END, $5, $6)" +
      " ON CONFLICT (tenant, source) DO UPDATE SET" +
      "   cursor = EXCLUDED.cursor," +
      "   updated_at = now()," +
      "   last_success_at = CASE WHEN $4 THEN now() ELSE sync_cursors.last_success_at END," +
      "   consecutive_failures = CASE WHEN $4 THEN 0 ELSE sync_cursors.consecutive_failures + 1 END," +
      "   last_error = $5," +
      // Overwritten every run, never accumulated: this describes the corpus as
      // it stands now, so a run that reads the previously-unreadable files must
      // be able to report zero. A running total could only grow and would
      // eventually describe nothing.
      "   last_run_item_failures = $6",
    [tenant, source, cursor, outcome.succeeded, outcome.error ?? null, outcome.itemFailures ?? 0],
  );
}

export interface SourceListing {
  ids: string[];
  /** Only an explicitly complete upstream listing may tombstone documents. */
  complete: boolean;
}
export interface ReconcileOutcome {
  status: "complete" | "incomplete";
  tombstoned: string[];
}

/** Fraction of a source's live documents a single reconcile may quarantine. */
export const MAX_RECONCILE_SHRINK = Number(process.env.EIL_RECONCILE_MAX_SHRINK ?? "0.5");

/**
 * A failed/partial listing is recorded but cannot mutate catalog visibility.
 * A complete listing tombstones missing documents for a quarantine period;
 * re-ingestion clears the tombstone, while purge is deliberately a separate
 * explicit retention operation.
 */
export async function reconcile(
  client: Db,
  source: string,
  listing: SourceListing,
  tenant = "default",
  actor?: string,
): Promise<ReconcileOutcome> {
  await client.query("BEGIN");
  try {
    if (!listing.complete) {
      await client.query(
        "INSERT INTO reconcile_runs (tenant, source, status, listed_count, actor) VALUES ($1, $2, 'incomplete', $3, $4)",
        [tenant, source, listing.ids.length, actor ?? null],
      );
      await client.query("COMMIT");
      return { status: "incomplete", tombstoned: [] };
    }
    // Shrink guard. `complete` only asserts the connector believed it reached the
    // end of the listing — it cannot detect a Confluence DC deep-pagination cap
    // returning a short page, a permissions change, or an unmounted Obsidian
    // vault, all of which present as a valid, short, "complete" listing. Refuse
    // rather than quarantine the corpus, and record the refusal. reconcile_runs
    // already carried listed_count and an index for exactly this lookup; nothing
    // read it until now.
    const live = await client.query(
      "SELECT count(*)::int AS n FROM documents WHERE source = $1 AND tenant = $2 AND tombstoned_at IS NULL",
      [source, tenant],
    );
    const before = Number(live.rows[0]?.n ?? 0);
    if (before > 0 && listing.ids.length < before * (1 - MAX_RECONCILE_SHRINK)) {
      await client.query(
        "INSERT INTO reconcile_runs (tenant, source, status, listed_count, actor) VALUES ($1, $2, 'incomplete', $3, $4)",
        [tenant, source, listing.ids.length, actor ?? null],
      );
      await client.query("COMMIT");
      const pct = Math.round(MAX_RECONCILE_SHRINK * 100);
      throw new Error(
        `reconcile refused for ${source}: listing has ${listing.ids.length} ids but ${before} are live (>${pct}% shrink). Re-run when the source is healthy, or set EIL_RECONCILE_MAX_SHRINK to override.`,
      );
    }
    const res = await client.query(
      "UPDATE documents SET tombstoned_at = now(), quarantine_until = now() + interval '7 days'" +
        " WHERE source = $1 AND tenant = $2 AND tombstoned_at IS NULL" +
        " AND NOT (id = ANY($3::text[])) RETURNING id",
      [source, tenant, listing.ids],
    );
    await client.query(
      "INSERT INTO reconcile_runs (tenant, source, status, listed_count, tombstoned_count, actor) VALUES ($1, $2, 'complete', $3, $4, $5)",
      [tenant, source, listing.ids.length, res.rows.length, actor ?? null],
    );
    await client.query("COMMIT");
    return { status: "complete", tombstoned: res.rows.map((r) => r.id as string) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Tombstone code documents that vanished from a full repo listing.
 *
 * `subpath` is not optional bookkeeping — it bounds the blast radius. A resync
 * scoped to one subtree yields a listing containing only that subtree, but the
 * tombstone matched on repo alone, so ingesting `svcB` quarantined every file
 * under `svcA`. In a monorepo where teams ingest their own subpath, each team's
 * run silently deleted every other team's code.
 *
 * Runs in a transaction and records a reconcile_runs row, matching the contract
 * reconcile() establishes for prose sources; the code path previously wrote no
 * audit trail at all, and the full-resync fallback that reaches it is entered
 * precisely when changedSince() failed (force-push, GC'd sha, shallow clone) —
 * exactly when the listing is least trustworthy.
 */
export async function reconcileCodeRepo(
  client: Db,
  repo: string,
  ids: string[],
  tenant = "default",
  subpath?: string,
): Promise<string[]> {
  const scope = subpath ? `${subpath.replace(/\/+$/, "")}/` : null;
  await client.query("BEGIN");
  try {
    const live = await client.query(
      "SELECT count(*)::int AS n FROM documents WHERE tenant = $1 AND source = 'code'" +
        " AND code_repo = $2 AND tombstoned_at IS NULL" +
        " AND ($3::text IS NULL OR code_path LIKE $3 || '%')",
      [tenant, repo, scope],
    );
    const before = Number(live.rows[0]?.n ?? 0);
    if (before > 0 && ids.length < before * (1 - MAX_RECONCILE_SHRINK)) {
      await client.query(
        "INSERT INTO reconcile_runs (tenant, source, status, listed_count) VALUES ($1, $2, 'incomplete', $3)",
        [tenant, `code:${repo}`, ids.length],
      );
      await client.query("COMMIT");
      const pct = Math.round(MAX_RECONCILE_SHRINK * 100);
      throw new Error(
        `reconcile refused for code:${repo}: listing has ${ids.length} files but ${before} are live (>${pct}% shrink). Re-run when the repo is reachable, or set EIL_RECONCILE_MAX_SHRINK to override.`,
      );
    }
    const res = await client.query(
      "UPDATE documents SET tombstoned_at = now(), quarantine_until = now() + interval '7 days'" +
        " WHERE tenant = $1 AND source = 'code' AND code_repo = $2 AND tombstoned_at IS NULL" +
        " AND ($4::text IS NULL OR code_path LIKE $4 || '%')" +
        " AND NOT (id = ANY($3::text[])) RETURNING id",
      [tenant, repo, ids, scope],
    );
    await client.query(
      "INSERT INTO reconcile_runs (tenant, source, status, listed_count, tombstoned_count) VALUES ($1, $2, 'complete', $3, $4)",
      [tenant, `code:${repo}`, ids.length, res.rows.length],
    );
    await client.query("COMMIT");
    return res.rows.map((r) => r.id as string);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Insert or update a document and its chunks/links. Returns true if content
 * changed. Owns its transaction: FOR UPDATE only serializes concurrent
 * upserts if the lock survives past the SELECT, so the BEGIN/COMMIT lives
 * here rather than being an invisible caller obligation.
 */
export async function upsertDocument(client: Db, doc: CanonicalDoc): Promise<boolean> {
  await client.query("BEGIN");
  try {
    const changed = await upsertInTx(client, doc);
    await client.query("COMMIT");
    return changed;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function upsertInTx(client: Db, doc: CanonicalDoc): Promise<boolean> {
  const hash = contentHash(doc);
  const aclSnapshot = JSON.stringify(doc.aclGroups);
  const aclVersion = sha256(aclSnapshot);
  const existing = await client.query(
    "SELECT content_hash, acl_version, ingested_by, tombstoned_at, secret_accepted FROM documents WHERE tenant = $1 AND id = $2 FOR UPDATE",
    [doc.tenant, doc.id],
  );
  const row = existing.rows[0];
  if (
    row &&
    row.content_hash === hash &&
    row.acl_version === aclVersion &&
    row.ingested_by &&
    !row.tombstoned_at
  ) {
    return false; // hash gate: nothing to do
  }
  // An empty ingested_by (pre-0003 rows) makes a doc invisible to everyone —
  // fail-closed but repairable: re-ingest falls through the gate and heals it.

  const write = await client.query(
    `INSERT INTO documents
        (id, tenant, source, title, url, author, created_at, updated_at,
         hierarchy, acl_groups, acl_snapshot, acl_version, quality_tier, content_hash, body, ingested_by,
         valid_from, valid_to, superseded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT (tenant, id) DO UPDATE SET
        title = EXCLUDED.title, url = EXCLUDED.url, author = EXCLUDED.author,
        created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
        hierarchy = EXCLUDED.hierarchy, acl_groups = EXCLUDED.acl_groups,
        acl_snapshot = EXCLUDED.acl_snapshot, acl_version = EXCLUDED.acl_version,
        quality_tier = EXCLUDED.quality_tier, content_hash = EXCLUDED.content_hash,
        body = EXCLUDED.body, ingested_at = now(),
        -- Validity is re-derived from the source on every ingest, so a page
        -- that loses its "obsolete" label becomes current again rather than
        -- staying dead because the first sync saw it retired.
        valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
        superseded_by = EXCLUDED.superseded_by,
        -- Ownership is NOT transferred by a re-ingest. Overwriting it meant any
        -- later writer — a refresh_doc call, another user's sync, the service
        -- account — silently re-owned the row, and since acl_groups is stamped
        -- empty by every connector today, ingested_by is the ONLY thing granting
        -- the original ingester access. They lost their own document. Keep the
        -- first owner; only adopt a new one to heal an empty pre-0003 value.
        ingested_by = COALESCE(NULLIF(documents.ingested_by, ''), EXCLUDED.ingested_by),
        tombstoned_at = NULL, quarantine_until = NULL, revision = documents.revision + 1
     RETURNING revision`,
    [
      doc.id,
      doc.tenant,
      doc.source,
      doc.title,
      doc.url ?? null,
      doc.author ?? null,
      doc.createdAt ?? null,
      doc.updatedAt ?? null,
      JSON.stringify(doc.hierarchy),
      JSON.stringify(doc.aclGroups),
      aclSnapshot,
      aclVersion,
      doc.qualityTier,
      hash,
      doc.body,
      userInfo().username,
      // valid_from falls back to createdAt/updatedAt so a source that says
      // nothing about validity still gets a sensible start rather than NULL.
      doc.validFrom ?? doc.createdAt ?? doc.updatedAt ?? null,
      doc.validTo ?? null,
      doc.supersededBy ?? null,
    ],
  );
  // Quarantine short-circuits the pipeline. This placement is the whole safety
  // argument: tsv, the embedding, ts_headline and the vector-arm snippet are all
  // downstream of chunking, so returning here means none of them can ever hold
  // the secret. Redacting on serve alone would still have left it searchable in
  // the tsvector, where a matching fragment confirms its presence.
  // Only findings nobody has reviewed hold the document back. Without this a
  // false positive could never be released: clearing the flag re-ran the
  // scanner, which found the same key-shaped string — a test fixture, an example
  // in documentation — and quarantined it again, forever.
  const accepted = (row?.secret_accepted as SecretFinding[] | null) ?? [];
  const findings = unacceptedFindings(scanSecrets(doc.body), accepted);
  await client.query(
    "UPDATE documents SET secret_findings = $1, quarantined_at = $2 WHERE tenant = $3 AND id = $4",
    [
      findings.length > 0 ? JSON.stringify(findings) : null,
      findings.length > 0 ? new Date() : null,
      doc.tenant,
      doc.id,
    ],
  );
  if (findings.length > 0) {
    await client.query("DELETE FROM chunks WHERE tenant = $1 AND doc_id = $2", [
      doc.tenant,
      doc.id,
    ]);
    console.error(
      `  ! quarantined ${doc.id}: ${findings.map((f) => `${f.rule} ${f.hint}`).join(", ")}`,
    );
    return true;
  }

  if (doc.codeRepo)
    await client.query(
      "UPDATE documents SET code_repo=$1, code_path=$2, code_ref=$3, code_language=$4, code_extractor_version=$5 WHERE tenant=$6 AND id=$7",
      [
        doc.codeRepo,
        doc.codePath ?? null,
        doc.codeRef ?? null,
        doc.codeLanguage ?? null,
        doc.codeExtractorVersion ?? null,
        doc.tenant,
        doc.id,
      ],
    );
  // Re-embedding is the dominant recurring cost in the system, and it was being
  // paid in full for every edit: DELETE every chunk, re-INSERT without the
  // embedding column, so a one-character typo fix on a 100-chunk runbook cost
  // 100 embeddings. chunks.content_hash was already computed on every write and
  // never read. Keep rows whose text is unchanged — their vectors survive — and
  // touch only what actually differs.
  //
  // This pairs with the metadata-aware contentHash landing in the same commit:
  // that change alters the document hash for every existing row, so the next
  // ingest re-writes the whole catalog. Without chunk-level reuse that re-write
  // would also discard every vector in the corpus.
  const fresh = chunk(doc);
  const prior = await client.query(
    "SELECT seq, content_hash FROM chunks WHERE tenant = $1 AND doc_id = $2",
    [doc.tenant, doc.id],
  );
  const priorBySeq = new Map<number, string>(
    prior.rows.map((r: any) => [Number(r.seq), r.content_hash as string]),
  );
  const freshSeqs = new Set(fresh.map((c) => c.seq));
  for (const seq of priorBySeq.keys()) {
    if (!freshSeqs.has(seq))
      await client.query("DELETE FROM chunks WHERE tenant = $1 AND doc_id = $2 AND seq = $3", [
        doc.tenant,
        doc.id,
        seq,
      ]);
  }
  for (const c of fresh) {
    const h = chunkHash(c);
    if (priorBySeq.get(c.seq) === h) continue; // identical text — keep the row and its vector
    await client.query(
      "INSERT INTO chunks (tenant, doc_id, seq, heading_path, text, content_hash, code_tokens)" +
        " VALUES ($1, $2, $3, $4, $5, $6, $7)" +
        " ON CONFLICT (tenant, doc_id, seq) DO UPDATE SET" +
        "   heading_path = EXCLUDED.heading_path, text = EXCLUDED.text," +
        "   content_hash = EXCLUDED.content_hash, code_tokens = EXCLUDED.code_tokens," +
        // the text changed, so any stored vector is now for the wrong text —
        // these four columns are dead since migration 0020 (nothing reads them)
        // but are kept NULLed for a clean rollback to the pre-0020 read path
        "   embedding = NULL, embed_model = NULL, sig = NULL, cluster_id = NULL",
      [
        doc.tenant,
        c.docId,
        c.seq,
        c.headingPath,
        c.text,
        h,
        // Only code carries an expansion; prose is served by the english tsv.
        // tsv_code is GENERATED from this column, so the two cannot drift.
        doc.source === "code" ? codeTokens(doc.codePath ?? doc.title, c.text) : null,
      ],
    );
    // The REAL vectors live in chunk_vectors (migration 0020) and the NULLing
    // above no longer reaches them. Without this delete, a chunk whose text
    // changed keeps serving its OLD text's vectors forever: backfill's
    // embed-once check is "does a current-model row exist for this seq", not
    // "is it fresh", so it never revisits a seq that still has stale rows —
    // and chunks_unembedded only counts chunks with NO vector, so a stale one
    // reports healthy. seq is not new here (it's a rewrite of an existing
    // chunk, guarded by priorBySeq above), so any rows under any model are
    // for text this chunk no longer has.
    await client.query("DELETE FROM chunk_vectors WHERE tenant = $1 AND doc_id = $2 AND seq = $3", [
      doc.tenant,
      c.docId,
      c.seq,
    ]);
  }
  await client.query("DELETE FROM links WHERE tenant = $1 AND src_id = $2", [doc.tenant, doc.id]);
  for (const link of doc.links) {
    // `rel` was omitted here, so every edge fell to the column default and the
    // relationship type the connector had already resolved was thrown away one
    // statement before it would have been persisted.
    await client.query(
      "INSERT INTO links (tenant, src_id, dst_id, rel) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [doc.tenant, doc.id, link.id, link.rel],
    );
  }
  await client.query(
    "INSERT INTO document_revisions (tenant, doc_id, revision, source, content_hash, acl_snapshot, acl_version) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [doc.tenant, doc.id, write.rows[0].revision, doc.source, hash, aclSnapshot, aclVersion],
  );
  return true;
}

/** Rebuild the deterministic, derived code projection for one indexed file/ref. */
export async function replaceCodeIndex(
  client: Db,
  doc: CanonicalDoc,
  repo: string,
  path: string,
  ref: string,
): Promise<void> {
  const entries = extractCodeIndex(path, doc.body);
  // Own the transaction. The delete + N inserts previously ran in autocommit
  // AFTER upsertDocument had already committed, so any failure mid-loop left a
  // document committed with a truncated index and no way to detect it — and the
  // window between the DELETE and the last INSERT exposed a partially-emptied
  // index for an existing file to concurrent readers.
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM code_index WHERE tenant = $1 AND doc_id = $2", [
      doc.tenant,
      doc.id,
    ]);
    for (const e of entries)
      await client.query(
        "INSERT INTO code_index (tenant, doc_id, repo, path, ref, kind, value, raw_value, line_start, line_end, symbol_kind, language, extractor_version)" +
          " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING",
        [
          doc.tenant,
          doc.id,
          repo,
          path,
          ref,
          e.kind,
          e.value,
          e.rawValue,
          e.lineStart,
          e.lineEnd,
          e.symbolKind ?? null,
          e.language,
          e.extractorVersion,
        ],
      );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
