# EIL — Enterprise Intelligence Layer

The knowledge plane: deterministic, token-free retrieval over org knowledge
(Confluence, Jira, code, notes), exposed to agents via MCP. **TypeScript**,
sharing one language and (eventually) one contracts package with the
work-side tool-discovery MCP connector.

Design docs: `docs/eil-architecture.html` (full solution),
`docs/knowledge-plane.html` (this plane + phased plan),
`docs/observability-plane.html` (metrics design).

**Operating model: local-first.** Everything runs on a laptop with no Docker —
macOS (brew), Linux (apt), Windows via WSL2. Components promote to Kubernetes
per the pathway in the design doc, each behind its own gate.

## Setup

Requirements everywhere: **Node 22+**, **pnpm 10+**, **PostgreSQL 16/17**, git.

### macOS

```sh
brew install postgresql@17 node pnpm
brew services start postgresql@17
createdb eil
```

### Linux (Ubuntu/Debian — same for WSL2)

```sh
sudo apt update && sudo apt install -y postgresql git curl
# Node 22+: use your org's package source, or nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22
corepack enable && corepack prepare pnpm@10 --activate
sudo service postgresql start
sudo -u postgres createuser -s "$USER" && createdb eil
```

Fedora/RHEL: `sudo dnf install postgresql-server nodejs`, then
`postgresql-setup --initdb`, `systemctl start postgresql`, same createuser/createdb.

### Windows

**Use WSL2 and follow the Linux steps inside it** — that is the supported
path. (`wsl --install -d Ubuntu` once, then everything above.) Native Windows
is explicitly not a target: the design doc records why (POSIX-only friction in
future components), and WSL2 removes the whole question.

### All platforms — project setup and smoke test

```sh
pnpm install
pnpm eil db migrate

pnpm eil ingest confluence --fixture tests/fixtures/confluence_page.json
pnpm eil ingest jira --fixture tests/fixtures/jira_issue.json
pnpm eil search "how do payment retries work"
pnpm eil search "PAY-981"      # entity route: catalog + link graph, zero search
pnpm eil ingest obsidian --vault ~/path/to/vault   # your notes, curated tier
pnpm test                       # 107 tests; DB suites use your local Postgres
```

Non-default Postgres? Set `EIL_DATABASE_URL` (12-factor: all endpoints via
env), e.g. `postgresql://user:pass@host:5432/eil`. Anything that speaks real
Postgres is a drop-in: another local version, WSL2 apt, an org PG server, or
managed offerings (RDS, Neon, Supabase, ...).

### Can't install Postgres at all? Zero-install mode (PGlite)

**Postgres installation is not a blocker.** Set one env var and the stack
runs real Postgres (compiled to WASM, in-process, from `node_modules`) — no
server, no binaries, no admin rights, nothing beyond `pnpm install`:

```sh
export EIL_DATABASE_URL=pglite://.eil-pglite   # data dir, gitignored
pnpm eil db migrate
pnpm eil ingest confluence --fixture tests/fixtures/confluence_page.json
pnpm eil search "PAY-981"                      # everything works identically
```

Because PGlite *is* Postgres, migrations, FTS, the jsonb ACL predicate, and
the metrics views run unchanged — `ts/tests/pglite.test.ts` proves the full
pipeline on this backend in CI.

**Concurrency decision rule.** PGlite is one process at a time — EIL enforces
this with a pidfile lock (PGlite itself would silently allow concurrent access,
which is worse; a second process gets a clear "in use by pid N" error). Fine
for bootstrap and sequential use (migrate, ingest, then serve). The moment two things must run at once (MCP server answering
while an ingest runs), switch tiers — it's only an env-var change, no code:

| Tier | Concurrent processes | Install rights |
|---|---|---|
| `pglite://<dir>` | no (exclusive lock) | none — pnpm only |
| `pnpm eil db embedded` (embedded-postgres, Linux/WSL2) | **yes** — real PG server as your user | none |
| apt-in-WSL2 / brew | yes | sudo in your distro / brew |
| org dev PG server (`EIL_DATABASE_URL=...`) | yes | none — ask for a schema |

Note the darwin-arm64 embedded binaries are broken upstream (missing ICU
dylib) — on macOS use brew; embedded is the Linux/WSL2 no-admin concurrency
tier, which is exactly the work-machine case. Kube promotion targets server
Postgres via a normal DSN either way.

## Integrating with existing MCP setups

EIL is a standard stdio MCP server — it registers next to any MCP servers you
already run; nothing about them changes. Tools exposed: `search_docs`,
`get_doc`, `expand`, `search_code`, `fetch_logs`. Two-phase by design —
search returns ids + snippets, fetch only what matters.

### Register in MCP clients (alongside existing servers)

**Amp** (`~/.config/amp/settings.json` or IDE settings — add under
`amp.mcpServers`, keeping your existing entries):

```json
{
  "amp.mcpServers": {
    "eil-knowledge": {
      "command": "pnpm",
      "args": ["-s", "--dir", "/path/to/eil", "eil", "serve"]
    }
  }
}
```

**Claude Code**:

```sh
claude mcp add eil-knowledge -- pnpm -s --dir /path/to/eil eil serve
```

**VS Code / Copilot agent mode** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "eil-knowledge": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["-s", "--dir", "/path/to/eil", "eil", "serve"]
    }
  }
}
```

Env vars (`EIL_DATABASE_URL`, `EIL_*_TOKEN`, ...) can be set per-entry via the
client's `env` field if the client doesn't inherit your shell environment.

### Aggregate under a tool-discovery connector (the work setup)

A routing/aggregating MCP connector treats EIL as one upstream among many:

1. **Index without spawning**: `pnpm -s eil tools` emits the manifest
   (`{name, description, inputSchema, requiresEnv}` per tool). Load it into
   the router's tool index so discovery costs zero processes and zero tokens.
2. **Spawn on demand**: when a call routes to an EIL tool, spawn
   `pnpm -s eil serve` as a child stdio MCP server and proxy
   `tools/call`; `tools/list` will match the manifest.
3. **In-process (TS hosts)**: skip the subprocess entirely — import
   `REGISTRY` / `callTool` from `ts/tools.ts`. Same env gating, ACLs, and
   audit logging as every other path.

**Name collisions**: if another server already exposes a `search_docs`-style
name, either rely on the client/connector's per-server namespacing (most
prefix tools with the server name), or rename at the aggregator — EIL tool
names are data in the manifest, not protocol constants.

### Coexisting with live-query MCP tools you already have

If you already run MCP servers that query Jira/Confluence/ELK live, keep
them — they answer a different question:

| Use | Tool |
|---|---|
| Find / look up / connect knowledge (cheap, indexed, ACL-filtered, ranked) | **EIL**: `search_docs`, `expand`, `search_code` |
| Fetch one indexed doc's content | **EIL**: `get_doc` (windowed) |
| Live state, writes, transitions (create ticket, add comment, current status) | your existing live MCP tools |
| Production logs | either — EIL's `fetch_logs` is the capped, audited read path |

Rules of thumb: retrieval goes through EIL (zero tokens, recency-ranked,
link-graph aware); mutations and moment-of-truth reads stay with the live
tools; and if an EIL result looks stale, `get_doc`-then-live-fetch is the
escalation path. Your existing extractors can also become ingestion feeders —
anything that emits the normalizer input shapes (see `ts/ingest/`) can fill
the catalog without new connector code.

## Live connectors (personal credentials only)

Set `EIL_CONFLUENCE_URL/TOKEN`, `EIL_JIRA_URL/TOKEN`, `EIL_BITBUCKET_URL/TOKEN`,
`EIL_ELK_URL/TOKEN` (DC PATs as Bearer; set `EIL_<PREFIX>_USER` for Basic auth
on older instances). Then `pnpm eil ingest confluence` (no --fixture) syncs
incrementally from the stored cursor. You can only ingest what you can read —
service accounts exist only on kube, after the ACL gate.

**Deletions.** Cursor sync sees updates, not removals. Add `--reconcile` to a
run (`pnpm eil ingest jira --reconcile`) to fetch the source's full id listing
and tombstone catalog docs that no longer exist there. It's a heavier call, so
run it periodically rather than every sync. (Obsidian reconciles automatically:
the vault walk already *is* a full listing.)

### Selective ingestion (granularity)

Ingest exactly what you need instead of the whole instance. Pick **one selector
family per run**; each selection re-syncs incrementally under its own cursor.

```sh
# Confluence
pnpm eil ingest confluence --space ENG,OPS         # one or more spaces
pnpm eil ingest confluence --page 12345 --with-descendants   # a page + its subtree
pnpm eil ingest confluence --page 12345,67890      # exact pages
pnpm eil ingest confluence --query 'label = incident'        # raw CQL (page predicate)

# Jira
pnpm eil ingest jira --project PAY,CHK             # one or more projects
pnpm eil ingest jira --issue PAY-981,PAY-42        # exact issues
pnpm eil ingest jira --query 'assignee = currentUser() AND sprint in openSprints()'
```

| Grain | Confluence | Jira |
|---|---|---|
| whole instance | (no flag) | (no flag) |
| container(s) | `--space K[,K2]` | `--project P[,P2]` |
| subtree | `--page ID --with-descendants` | — |
| exact item(s) | `--page ID[,ID2]` | `--issue K[,K2]` |
| anything | `--query '<CQL>'` | `--query '<JQL>'` |

Notes: space/project selections are incremental (own cursor per space/project);
exact `--page`/`--issue` always re-fetch the named items (hash-gated, so
unchanged docs are no-ops). `--reconcile` (deletion sweep) is **full-instance
only** — a scoped listing can't safely decide what to delete outside its scope.

### Storing tokens in the OS keychain (no env vars)

Instead of exporting `EIL_<PREFIX>_TOKEN`, store each PAT in your operating
system's credential store once:

```sh
pnpm eil auth login jira        # hidden prompt; stored in the OS keychain
pnpm eil auth status            # shows, per source, whether the token resolves
                                # from keychain / env / missing — never prints it
pnpm eil auth logout jira       # remove it
```

Resolution is **keychain-first, env-var fallback**: a token in the keychain
wins; `EIL_<PREFIX>_TOKEN` is used only when the keychain has no entry (so CI
and scripts keep working). Backends, no extra installs:

| Platform | Store |
|---|---|
| macOS | Keychain (`security`) |
| Windows | Credential Manager (`powershell.exe` + Win32 CredMan) |
| WSL2 | **bridges to Windows Credential Manager** — one store shared with the host |
| Linux | libsecret (`secret-tool`; `sudo apt install libsecret-tools`) |

If no backend is available, `auth login` says so and you fall back to the env
var. `EIL_KEYCHAIN_BACKEND` can force a backend if detection guesses wrong.

## Testing on the work machine — step by step

Windows work machine → do everything inside **WSL2** (native Windows is not a
support target). The sequence is deliberately staged: prove the stack with
fixtures before any org system is touched.

### 1. Prerequisites (once)

```sh
# inside WSL2 Ubuntu (or any Linux)
sudo apt install postgresql-17 git            # or postgresql + postgresql-contrib
corepack enable && corepack prepare pnpm@10 --activate   # pnpm via Node's corepack
node --version                                 # need 22+
sudo service postgresql start && sudo -u postgres createuser -s $USER
createdb eil
```

### 2. Get the code

If github.com is reachable: `git clone https://github.com/ashark-ai-05/eil.git`.
If it's blocked, bundle on the personal machine and carry the file over:

```sh
# personal machine:
git bundle create eil.bundle main
# work machine:
git clone eil.bundle eil && cd eil && git remote remove origin
```

### 3. Prove the stack offline — no org access needed

```sh
pnpm install
pnpm eil db migrate
pnpm test                       # 107 tests; DB suites run against your local PG
pnpm eil ingest confluence --fixture tests/fixtures/confluence_page.json
pnpm eil ingest jira --fixture tests/fixtures/jira_issue.json
pnpm eil search "PAY-981"       # entity route + link graph must work
```

Green here means the environment is sound. Only now touch real systems.

### 4. Corporate network realities (read before step 5)

- **Proxy**: Node's fetch does not honor `HTTPS_PROXY` by default. On Node 24+
  set `NODE_USE_ENV_PROXY=1`; otherwise export a global undici EnvHttpProxyAgent
  or run where the proxy is transparent.
- **Corporate CA**: TLS interception breaks fetch with self-signed-chain errors.
  Point Node at the corp root: `export NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem`.
  Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **Old DC instances**: if a PAT gets 401s, the instance may predate PAT
  support — set `EIL_<PREFIX>_USER=<username>` to switch that connector to
  Basic auth.

### 5. Create personal access tokens

Jira / Confluence DC: Profile → Personal Access Tokens (set an expiry).
Bitbucket DC: Manage account → HTTP access tokens — **read-only scope**.
Connectors never need write. These are YOUR tokens: you can only ingest what
you can already read, which is the local-mode ACL model.

```sh
export EIL_JIRA_URL=https://jira.yourorg.internal
export EIL_JIRA_TOKEN=...
export EIL_CONFLUENCE_URL=https://confluence.yourorg.internal
export EIL_CONFLUENCE_TOKEN=...
export EIL_BITBUCKET_URL=https://bitbucket.yourorg.internal   # for search_code
export EIL_BITBUCKET_TOKEN=...
```

Prefer not to keep tokens in your shell environment? Store them in the OS
keychain instead — `pnpm eil auth login jira` (etc.) — and skip the `export`s.

### 6. First live sync — seed the cursor first

**A first sync with no cursor pulls the ENTIRE instance.** On a large
Confluence that's a very long run and a lot of API calls. Seed the cursor to
start from recent history instead:

```sh
psql eil -c "INSERT INTO sync_cursors (source, cursor) VALUES
  ('confluence', '2026-07-01T00:00:00'), ('jira', '2026-07-01T00:00:00')"
pnpm eil ingest jira            # small first: recent issues
pnpm eil ingest confluence      # then pages; re-runs are incremental + hash-gated
```

Widen the window later by moving the cursor back. Re-running is always safe —
unchanged content is a no-op.

### 7. Validate against real content

```sh
pnpm eil search "<something you know is on the wiki>"
pnpm eil search "<a real ticket key>"          # entity route + linked context
pnpm eil audit --drift 20                      # sync faithful? sample + live-compare
```

Spot-check conversion quality: `get_doc` a page you know well and compare with
the real thing — the storage-format→markdown converter meeting your wiki's
macros for the first time is the likeliest place to find bugs. File samples of
any mangled pages; the normalizer has a test corpus for exactly this.

### 8. Wire into the work MCP connector

```sh
pnpm -s eil tools               # manifest JSON → index in the connector's router
```

Then either have the connector spawn `pnpm -s eil serve` (stdio MCP; discovery
via tools/list) on demand, or — same language now — import `REGISTRY`/`callTool`
from `ts/tools.ts` in-process. Also wire into work Amp via the MCP config above.

### 9. Start the feedback loops

Log real queries in `docs/golden-queries.md` (query → expected doc id) as you
use it; run `pnpm eil eval` to baseline recall on real data; `pnpm eil report`
shows adoption, zero-result rate, and the two-phase ratio — that data schedules
everything that gets built next (Zoekt, embeddings, nothing).

## Data-trust auditing

A cache of org knowledge is only useful if you can trust it's faithful and
complete. `pnpm eil audit` answers that in two independent ways:

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
- **Drift** — the only check internal consistency can't give you: `--drift <n>`
  samples N Confluence/Jira docs, re-fetches each **live with your personal
  credentials**, and compares content hashes. It reports `drifted` (catalog
  differs from source), `gone` (a 404 — a deletion `--reconcile` hasn't caught
  yet), and `skipped` (source env not configured). Silent sync bugs surface
  here and nowhere else.

Output is a single JSON report — pipe it into monitoring or read it by eye.

## Semantic search (vector arm)

Search fuses lexical FTS with a **semantic (vector) arm** via reciprocal-rank
fusion — so "money keeps getting stuck when I send it" finds "Parked payments
not alerting after retry exhaustion" with no shared keywords. It's **off until
you embed**, then automatic; nothing changes for pure-FTS setups.

The default embedder runs **fully in-process** via Transformers.js (ONNX) — no
network at query time, your content never leaves the machine, ideal for a
locked-down work PC:

```sh
pnpm eil embed backfill        # embeds with a local model (all-MiniLM-L6-v2, 384-dim)
pnpm eil search "why do payments get stuck"   # now fuses FTS + vector
```

The model (~90MB) downloads once from the HF hub and is cached.
`@huggingface/transformers` is an **optional dependency** (auto-installed unless
your `pnpm install` blocks native builds; otherwise `pnpm add @huggingface/transformers`).

**Air-gapped / corporate network that blocks huggingface.co?** Pre-download the
model on a machine that *can* reach the hub, carry it over, and run offline:

```sh
# on an unblocked machine (repo checked out):
EIL_EMBED_CACHE=./eil-models pnpm eil embed fetch-model   # writes ./eil-models/Xenova/...
# copy ./eil-models to the locked-down box, then there:
export EIL_EMBED_CACHE=/path/to/eil-models
export EIL_EMBED_OFFLINE=1        # forbid ANY network fetch
pnpm eil embed backfill          # loads from the cache, never touches the hub
```
(`EIL_EMBED_OFFLINE=1` works with or without `EIL_EMBED_CACHE` — set it whenever
the model is already local.)

- **Extension-free**: embeddings are packed float32 in a `bytea` column, cosine
  runs in-process — works on every Postgres tier (incl. zero-install PGlite)
  with no `CREATE EXTENSION` and no admin. Brute-force is fine at personal scale;
  pgvector/HNSW is a drop-in upgrade later.
- **Pluggable embedder** via `EIL_EMBED_PROVIDER`:
  - `local` (default) — in-process ONNX; `EIL_EMBED_MODEL` picks the model.
  - `http` — any OpenAI-compatible `/embeddings` endpoint (internal gateway,
    data stays in-org): `EIL_EMBED_BASE_URL` (falls back to `EIL_MAAS_BASE_URL`),
    `EIL_EMBED_MODEL`, `EIL_EMBED_API_KEY`.
  - `fake` — deterministic, no-network, for offline pipeline trials/CI.
- **Self-correcting on model change**: the vec arm only compares against chunks
  embedded by the *current* model, so switching `EIL_EMBED_MODEL` degrades to
  FTS-only until you `embed backfill --reembed`. Re-run `embed backfill` after
  ingesting more (embed-once skips unchanged chunks).
- **Degrades safely**: if the model/endpoint is unavailable or nothing is
  embedded yet, search silently stays lexical-only.

## Observability

Metrics live where the facts already are: `migrations/0005_metrics.sql`
defines the `metrics` schema and the `vw_*` views that ARE the metric
definitions — versioned, tested (ts/tests/metrics.test.ts recomputes every
aggregate independently). `pnpm eil eval` records each run for the recall
trend; `pnpm eil report` writes a self-contained HTML report; Grafana
provisioning for the same views lives in `observability/grafana/`.

## Development

```sh
pnpm test         # vitest; DB suites create their own databases, skip if no PG
pnpm typecheck    # strict tsc
pnpm lint         # biome
```

Language-neutral spec assets — `migrations/*.sql`, `tests/fixtures/`,
`tests/golden/`, `docs/golden-queries.md` — are the contract. The chunker
golden files are byte-identical with the original Python implementation,
which is how the TS port was verified.

## Status

- [x] Full TypeScript port, golden-verified against the Python original
- [x] Canonical model, chunker, router, RRF, rank modifiers (tier + recency)
- [x] Fail-closed ACL on every read path + 11-scenario red-team suite
- [x] Live connectors with **selective ingestion** — spaces/pages/subtrees, projects/issues, raw CQL/JQL, per-scope cursors
- [x] LLM provider layer: maas | amp | copilot; usage in `llm_calls`
- [x] Metrics schema + views + eval trend + HTML report + Grafana provisioning
- [x] Data-trust audit: integrity invariants (CI-gated) + live drift sampling
- [x] Zero-install PGlite backend + embedded-postgres no-admin concurrency tier
- [x] OS keychain auth: keychain-first token resolution (macOS/Windows/WSL2/libsecret) + `eil auth`
- [x] Semantic search: extension-free vector arm (bytea float32 + cosine) fused with FTS via rrf; `eil embed backfill`, pluggable embedder
- [ ] Golden-query log growth from real usage (`docs/golden-queries.md`)
- [ ] Per-user tokens + HTTP MCP transport (phase 2 — the kube rollout gate)
