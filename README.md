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

```sh
# 1. toolchain
brew install postgresql@17 node pnpm    # or apt equivalents on Linux/WSL
brew services start postgresql@17
createdb eil

# 2. project
pnpm install
pnpm eil db migrate

# 3. smoke-test with fixtures
pnpm eil ingest confluence --fixture tests/fixtures/confluence_page.json
pnpm eil ingest jira --fixture tests/fixtures/jira_issue.json
pnpm eil search "how do payment retries work"
pnpm eil search "PAY-981"      # entity route: catalog + link graph, zero search
pnpm eil ingest obsidian --vault ~/path/to/vault   # your notes, curated tier
```

Non-default Postgres? Set `EIL_DATABASE_URL` (12-factor: all endpoints via env).

## Wire into an agent (MCP over stdio)

```json
{
  "eil-knowledge": {
    "command": "pnpm",
    "args": ["-s", "--dir", "/path/to/eil", "eil", "serve"]
  }
}
```

Tools: `search_docs`, `get_doc`, `expand`, `search_code`, `fetch_logs`.
Two-phase by design — search returns ids + snippets, fetch only what matters.

### Hosting from the work-side TS connector

Three paths, all sharing `callTool()` (env gating, ACL viewer, audit logging):

1. **Runtime**: spawn `pnpm -s eil serve` as a child MCP server over stdio;
   `tools/list` answers discovery from the registry automatically.
2. **Static discovery** (token-lean routing): `pnpm -s eil tools` dumps the
   manifest — `{name, description, inputSchema, requiresEnv}` per tool. Index
   it; only spawn the server when a call routes here.
3. **In-process**: import `REGISTRY`/`callTool` from `ts/tools.ts` — same
   language now, so the work connector can also mount tools directly, and
   `ts/contracts/` is the future shared `@eil/contracts` package (zod schemas
   → types + JSON schema from one definition).

## Live connectors (personal credentials only)

Set `EIL_CONFLUENCE_URL/TOKEN`, `EIL_JIRA_URL/TOKEN`, `EIL_BITBUCKET_URL/TOKEN`,
`EIL_ELK_URL/TOKEN` (DC PATs as Bearer; set `EIL_<PREFIX>_USER` for Basic auth
on older instances). Then `pnpm eil ingest confluence` (no --fixture) syncs
incrementally from the stored cursor. You can only ingest what you can read —
service accounts exist only on kube, after the ACL gate.

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
pnpm test                       # 72 tests; DB suites run against your local PG
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
- [x] Live connectors (cursor CQL/JQL sync), Obsidian, Bitbucket search v0, ELK logs
- [x] LLM provider layer: maas | amp | copilot; usage in `llm_calls`
- [x] Metrics schema + views + eval trend + HTML report + Grafana provisioning
- [ ] Golden-query log growth from real usage (`docs/golden-queries.md`)
- [ ] Per-user tokens + HTTP MCP transport (phase 2 — the kube rollout gate)
