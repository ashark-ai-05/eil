/**
 * Corpus statistics for BM25.
 *
 * Everything here derives from `chunks.tsv`, which Postgres already maintains as
 * a generated column — so this is a refresh, never a second source of truth that
 * could disagree with the index.
 */

import type { Db } from "../db.js";

export interface CorpusStats {
  lexemes: number;
  nChunks: number;
  avgLen: number;
}

/**
 * Recompute df, N and avgdl.
 *
 * Deliberately a full rebuild rather than an incremental maintenance path.
 * Incremental df would have to be transactional on every chunk write, which
 * serialises ingestion on one hot row per lexeme — and the payoff is accuracy in
 * a number whose staleness only nudges ranking. Measured: 4573 lexemes over 20k
 * chunks in 4.5 s and 408 kB, so this is linear and cheap enough to schedule.
 */
export async function refreshStats(client: Db): Promise<CorpusStats> {
  await client.query("BEGIN");
  try {
    // len is the term count, the `dl` in BM25's length normalisation.
    await client.query(
      "UPDATE chunks SET len = length(tsv) WHERE len IS DISTINCT FROM length(tsv)",
    );

    // Swap-in rather than TRUNCATE + INSERT: readers of lexeme_stats during a
    // refresh should see the old table or the new one, never an empty one.
    await client.query("DROP TABLE IF EXISTS lexeme_stats_next");
    await client.query(
      "CREATE TABLE lexeme_stats_next AS" +
        " SELECT lexeme, count(*)::bigint AS df, now() AS refreshed_at" +
        " FROM chunks, unnest(tsv) u GROUP BY lexeme",
    );
    await client.query("CREATE UNIQUE INDEX lexeme_stats_next_pkey ON lexeme_stats_next (lexeme)");
    await client.query("DROP TABLE lexeme_stats");
    await client.query("ALTER TABLE lexeme_stats_next RENAME TO lexeme_stats");
    await client.query("ALTER INDEX lexeme_stats_next_pkey RENAME TO lexeme_stats_pkey");

    const agg = await client.query(
      "SELECT count(*)::bigint AS n, coalesce(avg(len), 0)::float8 AS avg FROM chunks",
    );
    const nChunks = Number(agg.rows[0].n);
    const avgLen = Number(agg.rows[0].avg);
    await client.query(
      "INSERT INTO corpus_stats (only_row, n_chunks, avg_len, refreshed_at)" +
        " VALUES (true, $1, $2, now())" +
        " ON CONFLICT (only_row) DO UPDATE SET" +
        "   n_chunks = EXCLUDED.n_chunks, avg_len = EXCLUDED.avg_len," +
        "   refreshed_at = EXCLUDED.refreshed_at",
      [nChunks, avgLen],
    );
    const lex = await client.query("SELECT count(*)::int AS n FROM lexeme_stats");
    await client.query("COMMIT");
    return { lexemes: Number(lex.rows[0].n), nChunks, avgLen };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** BM25 parameters. Standard defaults; step 5 will sweep them against eval. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/**
 * Query terms worth scanning for, rarest first, with the non-discriminative ones
 * dropped.
 *
 * This is the half of BM25 that also fixes a COST problem. The loose-OR fallback
 * ORs every content word, so a query containing `work` matches most of the
 * corpus — measured, that made BM25 *slower* than ts_rank (866 ms vs 229 ms at
 * 20k chunks) because it scored everything. Pruning by document frequency before
 * the scan improves precision and cost together.
 */
export async function discriminativeTerms(
  client: Db,
  query: string,
  maxDfFraction = 0.15,
): Promise<Array<{ lexeme: string; df: number }>> {
  const res = await client.query(
    `SELECT u.lexeme, coalesce(s.df, 0)::bigint AS df
       FROM unnest(to_tsvector('english', $1)) u
       LEFT JOIN lexeme_stats s ON s.lexeme = u.lexeme
      ORDER BY coalesce(s.df, 0), u.lexeme`,
    [query],
  );
  const total = await client.query("SELECT n_chunks FROM corpus_stats WHERE only_row");
  const n = Number(total.rows[0]?.n_chunks ?? 0);
  const cut = n * maxDfFraction;
  const rows = res.rows.map((r: any) => ({ lexeme: r.lexeme as string, df: Number(r.df) }));
  // Never return empty: if every term is common, the rarest ones are still the
  // best available signal, and returning nothing would turn a broad query into
  // a zero-result one — the exact failure the loose-OR fallback exists to avoid.
  const kept = rows.filter((r) => n === 0 || r.df < cut);
  return kept.length > 0 ? kept : rows.slice(0, 3);
}
