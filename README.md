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
