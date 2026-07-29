/**
 * Data-trust auditing: is the catalog a faithful, complete, healthy copy?
 *
 * integrity() — structural invariants every healthy catalog must satisfy
 * (cheap SQL, run anytime, CI-gated).
 * drift() — empirical sync correctness: sample docs, re-fetch them live from
 * the source with personal credentials, and compare content hashes. Catches
 * silent sync bugs that no amount of internal consistency checking can see.
 */

import { contentHash } from "./contracts/models.js";
import type { Db } from "./db.js";

export interface IntegrityReport {
  ok: boolean;
  docs_total: number;
  docs_without_chunks: number; // ingested but unsearchable — always a bug
  docs_unowned: number; // ingested_by='' — invisible to everyone (pre-0003 or bug)
  docs_empty_body: number; // conversion produced (almost) nothing
  docs_html_residue: number; // storage-format leaked through the converter
  chunks_null_tsv: number; // FTS index hole — always a bug
  docs_quarantined: number; // secrets found: invisible to reads, awaiting remediation
  chunks_over_embed_window: number; // tail silently dropped by the embedder
  links_dangling_dst: number; // informational: by-design "worth ingesting" markers
  stale_sources: string[]; // cursor age > 24h — connector rot tripwire
}

export async function integrity(client: Db): Promise<IntegrityReport> {
  const one = async (sql: string): Promise<number> =>
    Number((await client.query(sql)).rows[0]?.n ?? 0);

  const docsTotal = await one("SELECT count(*)::int AS n FROM documents");
  // Tenant must be part of the correlation since migration 0009. Without it a
  // HEALTHY copy in one tenant masks a chunkless copy in another, and the CI
  // gate this report exists to trip reports ok:true through a real fault.
  const withoutChunks = await one(
    "SELECT count(*)::int AS n FROM documents d" +
      // Quarantined documents are DELIBERATELY unchunked — that is the whole
      // safety property, since tsv/embedding/snippets are all downstream of
      // chunking. Counting them as an integrity fault made secret quarantine
      // working correctly fail `eil audit --strict`, i.e. the CI gate.
      // Tombstoned rows keep their chunks, so they are not excluded here.
      " WHERE d.quarantined_at IS NULL" +
      " AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.tenant = d.tenant AND c.doc_id = d.id)",
  );
  const unowned = await one("SELECT count(*)::int AS n FROM documents WHERE ingested_by = ''");
  const emptyBody = await one("SELECT count(*)::int AS n FROM documents WHERE length(body) < 40");
  // Prose only: this looks for HTML that survived the markdown conversion, and
  // source code legitimately CONTAINS html strings. Counting a template literal
  // in a .ts file as conversion residue is a false positive that trains people
  // to ignore the number.
  const htmlResidue = await one(
    "SELECT count(*)::int AS n FROM documents WHERE source <> 'code'" +
      " AND (body LIKE '%</div>%' OR body LIKE '%</p>%' OR body LIKE '%<ac:%')",
  );
  const nullTsv = await one("SELECT count(*)::int AS n FROM chunks WHERE tsv IS NULL");
  // Quarantined documents are invisible to every read path, so they cannot leak —
  // but they are also unsearchable, which makes them a remediation worklist rather
  // than a resolved state. Surfacing the count here is what stops them being
  // silently forgotten. `ok` deliberately does NOT fail on them: a quarantine is
  // the system working, not a defect.
  const quarantined = await one(
    "SELECT count(*)::int AS n FROM documents WHERE quarantined_at IS NOT NULL",
  );
  // Chunks longer than the embedder's window are SILENTLY truncated: no error,
  // just a vector that ignores the tail. Measured against the vendored MiniLM,
  // two 3200-char texts differing only past ~1600 chars embed to cosine
  // 1.000000. That is invisible from the outside, so count it here — the number
  // is the fraction of the corpus the vector arm is not actually reading.
  const { getEmbedder } = await import("./embed/index.js");
  let overWindow = 0;
  try {
    const w = getEmbedder().windowChars;
    if (Number.isFinite(w))
      overWindow = await one(
        `SELECT count(*)::int AS n FROM chunks WHERE length(heading_path) + length(text) > ${Math.floor(w)}`,
      );
  } catch {
    /* embedder unavailable: not an integrity fault */
  }
  const danglingDst = await one(
    "SELECT count(*)::int AS n FROM links l" +
      " WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.tenant = l.tenant AND d.id = l.dst_id)",
  );
  const stale = await client.query(
    "SELECT source FROM metrics.vw_connector_health WHERE age_hours > 24 ORDER BY source",
  );

  return {
    ok: withoutChunks === 0 && unowned === 0 && nullTsv === 0,
    docs_total: docsTotal,
    docs_without_chunks: withoutChunks,
    docs_unowned: unowned,
    docs_empty_body: emptyBody,
    docs_html_residue: htmlResidue,
    chunks_null_tsv: nullTsv,
    docs_quarantined: quarantined,
    chunks_over_embed_window: overWindow,
    links_dangling_dst: danglingDst,
    stale_sources: stale.rows.map((r) => r.source as string),
  };
}

export interface DriftReport {
  sampled: number;
  matched: number;
  drifted: string[]; // catalog differs from live source — sync bug or missed update
  gone: string[]; // live fetch 404s — deletion the reconcile hasn't caught yet
  skipped: string[]; // source unsupported or env not configured
}

/** Sample docs and compare stored content_hash against a live re-fetch. */
export async function drift(client: Db, sampleSize: number): Promise<DriftReport> {
  const rows = (
    await client.query(
      "SELECT id, source, content_hash FROM documents WHERE source IN ('confluence', 'jira')" +
        " ORDER BY random() LIMIT $1",
      [sampleSize],
    )
  ).rows as Array<{ id: string; source: string; content_hash: string }>;

  const report: DriftReport = { sampled: 0, matched: 0, drifted: [], gone: [], skipped: [] };

  for (const row of rows) {
    try {
      let liveHash: string;
      if (row.source === "confluence") {
        if (!process.env.EIL_CONFLUENCE_URL) {
          report.skipped.push(row.id);
          continue;
        }
        const { ConfluenceClient } = await import("./connectors/confluence.js");
        const { normalize } = await import("./ingest/confluence.js");
        const page = await new ConfluenceClient().getPage(row.id.slice("confluence:page:".length));
        liveHash = contentHash(normalize(page));
      } else {
        if (!process.env.EIL_JIRA_URL) {
          report.skipped.push(row.id);
          continue;
        }
        const { JiraClient } = await import("./connectors/jira.js");
        const { normalize } = await import("./ingest/jira.js");
        const issue = await new JiraClient().getIssue(row.id.slice("jira:issue:".length));
        liveHash = contentHash(normalize(issue));
      }
      report.sampled += 1;
      if (liveHash === row.content_hash) report.matched += 1;
      else report.drifted.push(row.id);
    } catch (err: any) {
      if (String(err.message).includes("404")) {
        report.sampled += 1;
        report.gone.push(row.id);
      } else {
        report.skipped.push(row.id);
      }
    }
  }
  return report;
}

/**
 * Persist a health report so it can trend and alert.
 *
 * integrity() and drift() are the best data-health signals in the codebase —
 * unowned docs, chunkless docs, FTS holes, and live re-fetch drift that no
 * amount of internal consistency can fake. Both printed JSON to stdout, so
 * neither had a trend and neither could ever fire an alert. Best-effort: a
 * bookkeeping failure must not fail the audit that produced the report.
 */
export async function recordHealth(
  client: Db,
  kind: "integrity" | "drift",
  ok: boolean,
  report: unknown,
): Promise<void> {
  try {
    await client.query("INSERT INTO metrics.health_runs (kind, ok, report) VALUES ($1, $2, $3)", [
      kind,
      ok,
      JSON.stringify(report),
    ]);
  } catch (err: any) {
    console.error(`health_runs skipped: ${err.message}`);
  }
}
