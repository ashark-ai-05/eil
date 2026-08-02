/**
 * Empirically re-derive OVERSAMPLE (ts/embed/ivf.ts) against the row grain
 * migration 0020 introduced: one chunk_vectors row per embedder WINDOW, not
 * per chunk.
 *
 * Committed rather than run-and-discard because a fix-round-1 review of the
 * first attempt at this constant (task-3-report.md) caught a real bug in the
 * experiment, not just the number: calibrate()'s oversample sweep runs at
 * FULL PROBE (measure(centroids.length, o) in ts/embed/buildivf.ts), where
 * `cand` is the WHOLE corpus (no cluster loss). Its survivor cut is
 * `.slice(0, 10 * oversample)` — so once `10 * oversample >= corpus size`,
 * that slice is a no-op, `got` becomes the exact top-10 of everything, and
 * recall reads 1.0000 by arithmetic, independent of oversample, embedder, or
 * windowing. The first attempt used a 240-row corpus and got exactly that
 * artifact at oversample=32 (10*32=320 > 240). This script instead:
 *
 *   1. Builds a WINDOWED corpus (docs sized to chunker.MAX_CHARS, embedded at
 *      the real vendored MiniLM's windowChars=1024, so ~4 windows/doc — the
 *      ratio ts/embed/window.ts's own header comment documents) large enough
 *      that every rung of OVERSAMPLE_LADDER = [4,8,16,32,64] genuinely cuts
 *      candidates: total rows > 10 * 64 = 640, with margin.
 *   2. Builds a NON-WINDOWED control at the SAME total row count (one window
 *      per doc), so row-grain (windows/chunk) is isolated from corpus size —
 *      the confound the first attempt's two differently-sized corpora had.
 *   3. Runs calibrate() on both and prints/logs the full oversample and
 *      nprobe curves.
 *
 * Usage:
 *   pnpm tsx scripts/ivf-oversample-experiment.ts [--docs=N] [--out=path]
 *
 *   --docs   documents in the WINDOWED corpus (default 500; ~4 windows/doc,
 *            so ~2000 chunk_vectors rows — 3x the 640-row binding threshold).
 *            The control corpus's doc count is not a flag: it is set to
 *            match the windowed corpus's MEASURED total row count exactly,
 *            after backfill, whatever that turns out to be.
 *   --out    append results here as each corpus finishes, so a disconnect
 *            mid-run costs only the remaining corpus, not the whole run.
 *            Default: a timestamped file next to this script's cwd, printed
 *            at startup. Not committed — pass a scratchpad path.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkHash, contentHash } from "../ts/contracts/models.js";
import { type Db, connect, migrate } from "../ts/db.js";
import {
  type CalibrationPoint,
  backfillSignatures,
  buildCentroids,
  calibrate,
} from "../ts/embed/buildivf.js";
import type { Embedder } from "../ts/embed/index.js";

function parseArgs(argv: string[]): { docs: number; out: string } {
  const get = (name: string, fallback: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const docs = Number(get("docs", "500"));
  const out = get("out", join(process.cwd(), `ivf-oversample-experiment-${Date.now()}.log`));
  return { docs, out };
}

/** Char-code-sum-mod-dim: overlapping windows of the SAME chunk share most of
 *  their characters (75% step overlap in embed/window.ts), so their vectors
 *  are correlated the way overlapping real-embedding windows are — unlike an
 *  independent per-window hash, which would understate how much near-duplicate
 *  candidates from one chunk compete for the same oversample budget. */
function charSumEmbedder(id: string, dim: number, windowChars: number): Embedder {
  return {
    id,
    windowChars,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const v = new Array(dim).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dim]! += t.charCodeAt(i) / 1000;
        const n = Math.hypot(...v) || 1;
        return Float32Array.from(v.map((x) => x / n));
      });
    },
  };
}

async function seedCorpus(client: Db, n: number, textLen: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const base = `Topic ${i % 6}: retry backoff dunning refund policy variant ${i} with body text. `;
    const text = base.repeat(Math.ceil(textLen / base.length)).slice(0, textLen);
    const doc = {
      title: `doc-${i}`,
      url: null,
      hierarchy: [],
      aclGroups: [],
      qualityTier: "authored" as const,
      updatedAt: null,
      body: text,
    };
    await client.query(
      "INSERT INTO documents (id, tenant, source, title, quality_tier, content_hash, body, ingested_by)" +
        " VALUES ($1, 'default', 'confluence', $2, 'authored', $3, $4, 'test')",
      [`doc-${i}`, `doc-${i}`, contentHash(doc), text],
    );
    await client.query(
      "INSERT INTO chunks (tenant, doc_id, seq, heading_path, text, content_hash)" +
        " VALUES ('default', $1, 0, '', $2, $3)",
      [`doc-${i}`, text, chunkHash({ text })],
    );
  }
}

function formatCurve(points: CalibrationPoint[]): string {
  return points
    .map(
      (p) =>
        `  nprobe=${String(p.nprobe).padStart(4)}  recall10=${p.recall10.toFixed(4)}  scanned=${p.scanned}`,
    )
    .join("\n");
}

function formatOversamplePoints(points: Array<{ oversample: number; recall10: number }>): string {
  return points
    .map(
      (p) => `  oversample=${String(p.oversample).padStart(3)}  recall10=${p.recall10.toFixed(4)}`,
    )
    .join("\n");
}

async function runCorpus(opts: {
  label: string;
  client: Db;
  embedder: Embedder;
  docs: number;
  textLen: number;
  log: (s: string) => void;
}): Promise<{
  rows: number;
  oversamplePoints: Array<{ oversample: number; recall10: number }>;
  oversample: number;
  points: CalibrationPoint[];
  chosen: number | null;
}> {
  const { label, client, embedder, docs, textLen, log } = opts;
  log(`\n=== ${label} ===`);
  log(`building: ${docs} docs, ${textLen} chars each, windowChars=${embedder.windowChars}`);
  await seedCorpus(client, docs, textLen);
  const { backfill } = await import("../ts/embed/backfill.js");
  const b = await backfill(client, embedder, { reembed: true });
  const rowCount = await client.query("SELECT count(*)::int AS n FROM chunk_vectors");
  const rows = rowCount.rows[0].n as number;
  log(
    `chunks embedded=${b.embedded}  chunk_vectors rows=${rows}  (${(rows / docs).toFixed(2)} windows/chunk)`,
  );
  const bindingThreshold = 10 * 64;
  log(
    `binding check: 10*max(OVERSAMPLE_LADDER)=${bindingThreshold} ${rows > bindingThreshold ? "<" : ">="} corpus rows=${rows} -> every ladder rung ${rows > bindingThreshold ? "GENUINELY BINDS" : "DOES NOT ALL BIND — invalid, raise --docs"}`,
  );

  await backfillSignatures(client, embedder.id);
  const built = await buildCentroids(client, embedder.id, {});
  log(`nlist=${built.nlist} assigned=${built.assigned}`);

  const cal = await calibrate(client, embedder, {});
  log(`queries=${cal.queries}`);
  log("oversample ladder (full probe, no cluster loss — isolates quantization loss):");
  log(formatOversamplePoints(cal.oversamplePoints));
  log(`chosen oversample: ${cal.oversample}`);
  log("nprobe curve (at chosen oversample):");
  log(formatCurve(cal.points));
  log(`chosen nprobe: ${cal.chosen}`);

  return {
    rows,
    oversamplePoints: cal.oversamplePoints,
    oversample: cal.oversample,
    points: cal.points,
    chosen: cal.chosen,
  };
}

async function main() {
  const { docs, out } = parseArgs(process.argv.slice(2));
  writeFileSync(out, "");
  const log = (s: string) => {
    console.log(s);
    appendFileSync(out, `${s}\n`);
  };
  log(`log file: ${out}`);
  log(`args: --docs=${docs}`);

  const dir = mkdtempSync(join(tmpdir(), "eil-ivf-oversample-"));
  process.env.EIL_DATABASE_URL = `pglite://${dir}`;
  const client = await connect();
  await migrate(client);

  // Windowed corpus: real chunker.MAX_CHARS (3200) at the real vendored
  // MiniLM's windowChars (1024) -> ~4 windows/doc.
  const windowed = charSumEmbedder("exp:windowed32", 32, 1024);
  const windowedResult = await runCorpus({
    label: "WINDOWED (~4 windows/chunk, production ratio)",
    client,
    embedder: windowed,
    docs,
    textLen: 3200,
    log,
  });

  // Reset for the control: same embedder MATH (charSumEmbedder), but a
  // windowChars large enough that embedWindows() never splits — one row per
  // chunk, same as pre-migration-0020. Doc count is set to MATCH the windowed
  // corpus's measured total row count, so total corpus size is controlled for
  // and only windows-per-chunk varies (C-2).
  await client.query("DELETE FROM chunk_vectors");
  await client.query("DELETE FROM chunks");
  await client.query("DELETE FROM documents");
  await client.query("DELETE FROM ivf_centroids");
  await client.query("DELETE FROM metrics.ivf_calibration");
  const nonWindowed = charSumEmbedder("exp:control32", 32, Number.MAX_SAFE_INTEGER);
  const controlResult = await runCorpus({
    label: `NON-WINDOWED CONTROL (1 window/chunk, ${windowedResult.rows} docs to match total rows)`,
    client,
    embedder: nonWindowed,
    docs: windowedResult.rows,
    textLen: 400, // content length is irrelevant here — never windows regardless
    log,
  });

  log("\n=== SUMMARY ===");
  log(
    `windowed:      rows=${windowedResult.rows}  chosen oversample=${windowedResult.oversample}  chosen nprobe=${windowedResult.chosen}`,
  );
  log(
    `control:       rows=${controlResult.rows}  chosen oversample=${controlResult.oversample}  chosen nprobe=${controlResult.chosen}`,
  );
  log(
    "If windowed needs a materially larger oversample than the control at the SAME row count, that is evidence windowing itself (not just corpus size) degrades quantization recall at fixed oversample. If they land close, corpus size was the dominant effect, not windowing.",
  );

  await client.end();
  rmSync(dir, { recursive: true, force: true });
  log(`\ndone. full log: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
