# Operating EIL

## Semantic search (vector arm)

Search fuses lexical FTS with a **semantic (vector) arm** via reciprocal-rank
fusion — so "money keeps getting stuck when I send it" finds "Parked payments
not alerting after retry exhaustion" with no shared keywords. It's **off until
you embed**, then automatic; nothing changes for pure-FTS setups.

```sh
pnpm eil embed backfill                        # uses the vendored local model — no download
pnpm eil search "why do payments get stuck"    # now fuses FTS + vector
```

The default embedder runs **fully in-process, fully offline** via
Transformers.js (ONNX). The model (quantized `all-MiniLM-L6-v2`, 384-dim,
~23 MB) is **vendored in the repo** under `models/`, so it travels with the
code and never calls the Hugging Face hub — ideal for a locked-down or
air-gapped machine.

`@huggingface/transformers` (the ONNX runtime) is an **optional dependency** —
auto-installed unless your `pnpm install` blocks native builds; otherwise
`pnpm add @huggingface/transformers`. To swap models, set
`EIL_EMBED_CACHE`/`EIL_EMBED_MODEL` and `EIL_EMBED_ALLOW_REMOTE=1` for a
one-time hub fetch on a connected machine.

- **Extension-free.** Embeddings are stored unit-normalized as `float4[]`, so
  cosine reduces to a dot product Postgres computes itself — scoring,
  best-chunk-per-doc and the top-N cut all happen in SQL, and only the winners
  cross the wire. Works on every Postgres tier including PGlite, with no
  `CREATE EXTENSION` and no admin. Scoring is still a linear scan; an LSH
  sketch column (or pgvector/HNSW where the extension exists) is the sub-linear
  upgrade later. Note pgvector is **not** available on PGlite.
- **Pluggable** via `EIL_EMBED_PROVIDER`:
  - `local` (default) — in-process ONNX; `EIL_EMBED_MODEL` picks the model.
  - `http` — any OpenAI-compatible `/embeddings` endpoint (internal gateway,
    data stays in-org): `EIL_EMBED_BASE_URL` (falls back to
    `EIL_MAAS_BASE_URL`), `EIL_EMBED_MODEL`, `EIL_EMBED_API_KEY`.
  - `fake` — deterministic, no-network, for offline pipeline trials and CI.
- **Self-correcting on model change.** The vec arm only compares against chunks
  embedded by the *current* model, so switching `EIL_EMBED_MODEL` degrades to
  FTS-only until you `embed backfill --reembed`. Re-run `embed backfill` after
  ingesting more (embed-once skips unchanged chunks).
- **Degrades safely.** If the model or endpoint is unavailable, or nothing is
  embedded yet, search silently stays lexical-only.

## Data-trust auditing

A cache of org knowledge is only useful if you can trust it's faithful and
complete. `pnpm eil audit` answers that two independent ways:

```sh
pnpm eil audit                  # integrity invariants only (cheap, offline)
pnpm eil audit --strict         # same, but exit non-zero if any invariant fails
pnpm eil audit --drift 20       # also re-fetch 20 sampled docs live and compare
```

- **Integrity** — structural invariants a healthy catalog must satisfy, all
  cheap SQL over the facts already stored: no chunkless (unsearchable) docs, no
  unowned (ACL-invisible) docs, no FTS index holes, plus soft counters for
  empty bodies and HTML-conversion residue, and a stale-cursor tripwire
  (connector rot > 24h). `--strict` makes the hard invariants a CI gate — the
  pipeline runs `eil audit --strict` and asserts `"ok": true` on every push.
- **Drift** — the only check internal consistency can't give you. `--drift <n>`
  samples N Confluence/Jira docs, re-fetches each **live with your personal
  credentials**, and compares content hashes. It reports `drifted` (catalog
  differs from source), `gone` (a 404 — a deletion `--reconcile` hasn't caught
  yet), and `skipped` (source env not configured). Silent sync bugs surface
  here and nowhere else.

Output is a single JSON report — pipe it into monitoring or read it by eye.

## Observability

Metrics live where the facts already are: `migrations/0005_metrics.sql` defines
the `metrics` schema and the `vw_*` views that **are** the metric definitions —
versioned, and tested by `ts/tests/metrics.test.ts`, which recomputes every
aggregate independently.

```sh
pnpm eil eval      # records each run for the recall trend
pnpm eil report    # writes a self-contained HTML report (adoption, zero-result, two-phase)
```

Grafana provisioning for the same views lives in `observability/grafana/`.

Log real queries in `golden-queries.md` (query → expected doc id) as you use
the system; that log is what `eil eval` scores against, and the resulting data
schedules what gets built next.

## Development

```sh
pnpm test         # vitest; DB suites create their own databases, skip if no PG
pnpm typecheck    # strict tsc
pnpm lint         # biome
pnpm map:check    # fails if docs/system-map.html has drifted from the code
```

Language-neutral spec assets — `migrations/*.sql`, `tests/fixtures/`,
`tests/golden/`, `docs/golden-queries.md` — are the contract. The chunker
golden files are byte-identical with the original Python implementation, which
is how the TS port was verified.

`docs/system-map.html` is partly generated: `pnpm map:build` re-derives the
tool list, metrics views and ingest adapters from the code, and `map:check`
runs in CI so the diagram can't silently go stale.
