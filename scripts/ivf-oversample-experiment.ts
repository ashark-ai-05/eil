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

// A first attempt used a char-code-sum-mod-dim hash embedder. At corpus sizes
// large enough to satisfy C-1's binding requirement (thousands of rows), that
// geometry turned out to be nearly unstructured — full-probe recall (no
// cluster loss at all) collapsed to ~0.04-0.41 even at the top of
// OVERSAMPLE_LADDER, for BOTH corpora. That is not a windowing effect, it is
// hash noise: with no real topical structure, sign-bit quantization has
// nothing coherent to preserve. It would have produced a curve, but not one
// that says anything about windows vs. chunks.
//
// This embedder instead has EXPLICIT, controllable cluster structure: `nTopics`
// random unit directions in `dim`-space act as ground-truth topics; a chunk's
// vector is its topic direction plus per-chunk noise; a WINDOW's vector is its
// chunk's vector plus a further, smaller per-window noise — modeling how real
// overlapping windows of the same chunk (75% step overlap, embed/window.ts)
// are near-duplicates of each other, not independent draws. Topic and doc
// identity ride in `headingPath` (prepended to every window's embedded text by
// embedWindows(), so every window can recover them); text queries sampled
// later from the raw `chunks.text` column (no heading prefix) fall back to a
// hash of the query text itself, deterministic either way.
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function unitVector(rng: () => number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rng() * 2 - 1;
  const n = Math.hypot(...v) || 1;
  for (let i = 0; i < dim; i++) v[i]! /= n;
  return v;
}
/** `out = normalize(base * (1-scale) + noise * scale)` — `scale` in [0,1]
 *  controls how far `out` drifts from `base` toward an independent direction. */
function blend(base: Float32Array, noise: Float32Array, scale: number): Float32Array {
  const v = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) v[i] = base[i]! * (1 - scale) + noise[i]! * scale;
  const n = Math.hypot(...v) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

const TOPIC_TAG = /^T(\d+)D(\d+)\n/;

function structuredEmbedder(opts: {
  id: string;
  dim: number;
  windowChars: number;
  nTopics: number;
  chunkNoise: number; // doc-vs-doc spread within a topic
  windowNoise: number; // window-vs-window spread within a chunk (<< chunkNoise)
}): Embedder {
  const topicRng = mulberry32(0xc0ffee);
  const topics = Array.from({ length: opts.nTopics }, () => unitVector(topicRng, opts.dim));
  return {
    id: opts.id,
    windowChars: opts.windowChars,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const m = TOPIC_TAG.exec(t);
        const topic = m ? Number(m[1]) % opts.nTopics : hashString(t) % opts.nTopics;
        const docSeed = m ? Number(m[2]) : hashString(t);
        const chunkVec = blend(
          topics[topic]!,
          unitVector(mulberry32(Math.imul(docSeed, 2654435761) ^ 0x9e3779b9), opts.dim),
          opts.chunkNoise,
        );
        return blend(chunkVec, unitVector(mulberry32(hashString(t)), opts.dim), opts.windowNoise);
      });
    },
  };
}

async function seedCorpus(client: Db, n: number, textLen: number, nTopics: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    // The tag is carried in headingPath, not body text — embedWindows()
    // prepends headingPath to EVERY window, so every window's embedded text
    // starts with it regardless of where in the chunk that window falls.
    const headingPath = `T${i % nTopics}D${i}`;
    const base = `retry backoff dunning refund policy variant ${i} with body text. `;
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
        " VALUES ('default', $1, 0, $2, $3, $4)",
      [`doc-${i}`, headingPath, text, chunkHash({ text })],
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
  nTopics: number;
  log: (s: string) => void;
}): Promise<{
  rows: number;
  oversamplePoints: Array<{ oversample: number; recall10: number }>;
  oversample: number;
  points: CalibrationPoint[];
  chosen: number | null;
}> {
  const { label, client, embedder, docs, textLen, nTopics, log } = opts;
  log(`\n=== ${label} ===`);
  log(`building: ${docs} docs, ${textLen} chars each, windowChars=${embedder.windowChars}`);
  await seedCorpus(client, docs, textLen, nTopics);
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

  // 60 topics ~ sqrt(4000 target rows), so kmeans has a real chance of
  // recovering them as clusters — this run is about isolating oversample
  // (quantization) loss from cluster loss, not re-testing k-means itself.
  const NTOPICS = 60;
  const DIM = 64;
  const CHUNK_NOISE = 0.35; // docs within one topic are related but distinct
  const WINDOW_NOISE = 0.1; // windows within one chunk are near-duplicates

  // Windowed corpus: real chunker.MAX_CHARS (3200) at the real vendored
  // MiniLM's windowChars (1024) -> ~4 windows/doc.
  const windowed = structuredEmbedder({
    id: "exp:windowed64",
    dim: DIM,
    windowChars: 1024,
    nTopics: NTOPICS,
    chunkNoise: CHUNK_NOISE,
    windowNoise: WINDOW_NOISE,
  });
  const windowedResult = await runCorpus({
    label: "WINDOWED (~4 windows/chunk, production ratio)",
    client,
    embedder: windowed,
    docs,
    textLen: 3200,
    nTopics: NTOPICS,
    log,
  });

  // Reset for the control: same structured-embedder math and same nTopics /
  // chunkNoise (so doc-vs-doc spread within a topic is identical), but
  // windowChars large enough that embedWindows() never splits — one row per
  // chunk, same as pre-migration-0020 — so windowNoise never applies. Doc
  // count is set to MATCH the windowed corpus's measured total row count, so
  // total corpus size is controlled for and only windows-per-chunk varies
  // (C-2).
  await client.query("DELETE FROM chunk_vectors");
  await client.query("DELETE FROM chunks");
  await client.query("DELETE FROM documents");
  await client.query("DELETE FROM ivf_centroids");
  await client.query("DELETE FROM metrics.ivf_calibration");
  const nonWindowed = structuredEmbedder({
    id: "exp:control64",
    dim: DIM,
    windowChars: Number.MAX_SAFE_INTEGER,
    nTopics: NTOPICS,
    chunkNoise: CHUNK_NOISE,
    windowNoise: WINDOW_NOISE, // unused: never more than 1 window/chunk here
  });
  const controlResult = await runCorpus({
    label: `NON-WINDOWED CONTROL (1 window/chunk, ${windowedResult.rows} docs to match total rows)`,
    client,
    embedder: nonWindowed,
    docs: windowedResult.rows,
    textLen: 400, // content length is irrelevant here — never windows regardless
    nTopics: NTOPICS,
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
