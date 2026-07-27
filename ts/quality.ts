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
  links_dangling_dst: number; // informational: by-design "worth ingesting" markers
  stale_sources: string[]; // cursor age > 24h — connector rot tripwire
}

export async function integrity(client: Db): Promise<IntegrityReport> {
  const one = async (sql: string): Promise<number> =>
    Number((await client.query(sql)).rows[0]?.n ?? 0);

  const docsTotal = await one("SELECT count(*)::int AS n FROM documents");
  const withoutChunks = await one(
    "SELECT count(*)::int AS n FROM documents d" +
      " WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.doc_id = d.id)",
  );
  const unowned = await one("SELECT count(*)::int AS n FROM documents WHERE ingested_by = ''");
  const emptyBody = await one("SELECT count(*)::int AS n FROM documents WHERE length(body) < 40");
  const htmlResidue = await one(
    "SELECT count(*)::int AS n FROM documents WHERE body LIKE '%</div>%' OR body LIKE '%</p>%'" +
      " OR body LIKE '%<ac:%'",
  );
  const nullTsv = await one("SELECT count(*)::int AS n FROM chunks WHERE tsv IS NULL");
  const danglingDst = await one(
    "SELECT count(*)::int AS n FROM links l" +
      " WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = l.dst_id)",
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
