/**
 * What is actually in the index, and what is scoring it.
 *
 * The claim this exists to make checkable is that the semantic arm needs no
 * vector database and no Postgres extension: vectors are unit-normalized
 * float4[], so cosine is a plain dot product the database computes itself
 * (migration 0008). That is easy to say and easy to disbelieve, so this prints
 * the installed extension list and the scoring expression, taken from the
 * source rather than retyped, next to the counts.
 *
 * Everything here is read-only.
 */

import { type Db, connect, dsn } from "./db.js";
import { GET_DOC_MAX_CHARS } from "./search.js";

/**
 * The expression that scores similarity, quoted from ts/search.ts.
 *
 * Kept as a constant so it can be shown without anyone reading it off a slide
 * that has drifted. `assertScorerMatchesSearch` in the tests fails if the real
 * query stops containing it.
 */
export const SCORING_SQL =
  "SELECT sum(a::float8 * b::float8) FROM unnest(c.embedding, $4::float4[]) AS t(a, b)";

/** MiniLM's input window, in characters. Approximate by construction. */
export const EMBED_WINDOW_CHARS = 1_024;

export interface SourceCount {
  source: string;
  documents: number;
  chunks: number;
}

export interface IndexStats {
  backend: "pglite" | "postgres";
  postgresVersion: string;
  /** Non-core extensions installed. The point is that this is empty. */
  extensions: string[];
  sources: SourceCount[];
  documents: number;
  chunks: number;
  embeddedChunks: number;
  /** Numbers per vector, read off a stored row rather than from configuration. */
  vectorDim: number | null;
  embedModel: string | null;
  /**
   * Chunks longer than the embedding model's input window.
   *
   * A real ceiling, reported rather than buried: the vector arm reads only the
   * first part of these. Lexical retrieval is unaffected.
   */
  chunksOverEmbedWindow: number;
  /** Documents longer than one get_doc window, so an agent may need a second call. */
  docsOverGetDocWindow: number;
  scoringSql: string;
}

const num = (v: unknown): number => Number(v ?? 0);

export async function indexStats(client: Db): Promise<IndexStats> {
  const version = await client.query("SELECT version() AS v");
  // Core extensions ship with every Postgres and are not something anyone has
  // to install; listing them would bury the answer. pgvector, if it were here,
  // would not be in this list.
  const exts = await client.query(
    "SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql') ORDER BY extname",
  );

  const bySource = await client.query(
    `SELECT d.source,
            count(DISTINCT d.id) AS documents,
            count(c.doc_id)      AS chunks
       FROM documents d LEFT JOIN chunks c ON c.tenant = d.tenant AND c.doc_id = d.id
      GROUP BY d.source ORDER BY d.source`,
  );

  const totals = await client.query(
    `SELECT (SELECT count(*) FROM documents)                         AS documents,
            (SELECT count(*) FROM chunks)                            AS chunks,
            (SELECT count(*) FROM chunks WHERE embedding IS NOT NULL) AS embedded`,
  );

  // Dimension and model come off a stored row, not from configuration — what is
  // configured and what is in the table are exactly the thing worth telling
  // apart when the vector arm is quietly not running.
  const sample = await client.query(
    "SELECT array_length(embedding, 1) AS dim, embed_model FROM chunks WHERE embedding IS NOT NULL LIMIT 1",
  );

  const oversize = await client.query(
    `SELECT (SELECT count(*) FROM chunks WHERE length(text) > $1)   AS over_embed,
            (SELECT count(*) FROM documents WHERE length(body) > $2) AS over_getdoc`,
    [EMBED_WINDOW_CHARS, GET_DOC_MAX_CHARS],
  );

  const url = dsn();
  return {
    backend: url.startsWith("pglite://") ? "pglite" : "postgres",
    postgresVersion: String(version.rows[0]?.v ?? "unknown").split(" on ")[0] ?? "unknown",
    extensions: exts.rows.map((r) => String(r.extname)),
    sources: bySource.rows.map((r) => ({
      source: String(r.source),
      documents: num(r.documents),
      chunks: num(r.chunks),
    })),
    documents: num(totals.rows[0]?.documents),
    chunks: num(totals.rows[0]?.chunks),
    embeddedChunks: num(totals.rows[0]?.embedded),
    vectorDim: sample.rows[0]?.dim == null ? null : num(sample.rows[0].dim),
    embedModel: sample.rows[0]?.embed_model == null ? null : String(sample.rows[0].embed_model),
    chunksOverEmbedWindow: num(oversize.rows[0]?.over_embed),
    docsOverGetDocWindow: num(oversize.rows[0]?.over_getdoc),
    scoringSql: SCORING_SQL,
  };
}

export function formatIndexStats(s: IndexStats): string {
  const n = (x: number) => x.toLocaleString("en-GB");
  const lines = [
    `backend        ${s.backend}  —  ${s.postgresVersion}`,
    `extensions     ${s.extensions.length === 0 ? "none installed" : s.extensions.join(", ")}`,
    "",
    "  source          documents    chunks",
    ...s.sources.map(
      (r) => `  ${r.source.padEnd(14)}${n(r.documents).padStart(9)}${n(r.chunks).padStart(10)}`,
    ),
    `  ${"total".padEnd(14)}${n(s.documents).padStart(9)}${n(s.chunks).padStart(10)}`,
    "",
  ];

  if (s.embeddedChunks === 0) {
    lines.push(
      "vectors        none — the semantic arm is not running, and search is",
      "               lexical only. That is a degraded mode, not a broken one.",
    );
  } else {
    lines.push(
      `vectors        ${n(s.embeddedChunks)} chunks × ${s.vectorDim} float4, unit-normalized`,
      `model          ${s.embedModel}`,
      `scored by      ${s.scoringSql}`,
      "               Cosine reduces to a dot product because the vectors are",
      "               unit length, so this is core Postgres. No extension.",
    );
  }

  if (s.chunksOverEmbedWindow > 0 && s.embeddedChunks > 0) {
    const pct = Math.round((s.chunksOverEmbedWindow / s.chunks) * 100);
    lines.push(
      "",
      `ceiling        ${n(s.chunksOverEmbedWindow)} chunks (${pct}%) exceed the model's ~${n(
        EMBED_WINDOW_CHARS,
      )}-char`,
      "               window, so the vector arm reads only their opening. Real,",
      "               known, and not hidden by this report.",
    );
  }
  if (s.docsOverGetDocWindow > 0) {
    lines.push(
      `               ${n(s.docsOverGetDocWindow)} document(s) exceed one get_doc window of ` +
        `${n(GET_DOC_MAX_CHARS)} chars.`,
    );
  }
  return lines.join("\n");
}

export async function runIndexStats(): Promise<IndexStats> {
  const client = await connect();
  try {
    return await indexStats(client);
  } finally {
    await client.end();
  }
}
