# EIL — Enterprise Intelligence Layer

The knowledge plane: deterministic, token-free retrieval over org knowledge
(Confluence, Jira, code, notes), exposed to agents via MCP.

Design docs: `docs/eil-architecture.html` (full solution) and
`docs/knowledge-plane.html` (this plane, with the phased plan this repo follows).

**Operating model: local-first.** Everything runs on a laptop with no Docker —
macOS (brew), Linux (apt), Windows via WSL2 (native Windows is not a target).
Components promote to Kubernetes per the pathway in the design doc, each behind
its own gate.

## Setup

```sh
# 1. toolchain
brew install postgresql@17    # or apt install postgresql on Linux/WSL
brew services start postgresql@17
createdb eil

# 2. project
uv sync
uv run eil db migrate

# 3. smoke-test with fixtures
uv run eil ingest confluence --fixture tests/fixtures/confluence_page.json
uv run eil ingest jira --fixture tests/fixtures/jira_issue.json
uv run eil search "how do payment retries work"
uv run eil search "PAY-981"     # entity route: catalog + link graph, zero search
```

Non-default Postgres? Set `EIL_DATABASE_URL` (12-factor rule: all endpoints via env).

## Wire into an agent (MCP over stdio)

Amp / Claude Code MCP config:

```json
{
  "eil-knowledge": {
    "command": "uv",
    "args": ["run", "--directory", "/path/to/eil", "eil", "serve"]
  }
}
```

Tools exposed: `search_docs`, `get_doc`, `expand`, `search_code`, `fetch_logs`.
Two-phase by design — search cheap, fetch only what matters.

### Hosting from a TypeScript tool-discovery connector (work setup)

The language boundary is the MCP wire protocol — nothing imports Python:

1. **Runtime**: the TS connector spawns `uv run eil serve` as a child MCP
   server over stdio and proxies `tools/list` + `tools/call`. FastMCP answers
   discovery from the same registry, so names/descriptions/schemas arrive
   over the wire automatically.
2. **Static discovery** (token-lean routing without spawning anything):
   `uv run eil tools` dumps the manifest as JSON — `{name, description,
   inputSchema, requiresEnv}` per tool. Index it in the connector's router;
   only spawn the server when a call actually routes here.
3. **Python hosts** (same-process): import `eil.tools.REGISTRY` and dispatch
   via `call_tool()` — used by the CLI itself.

All three paths share `tools.call_tool()`, so env gating, ACL viewer, and
audit logging behave identically regardless of host. Config is env-vars only
(12-factor): the work machine sets its own `EIL_*` vars and nothing else
changes.

## Observability

Metrics live where the facts already are: `migrations/0005_metrics.sql`
creates the `metrics` schema (usage_facts, eval_runs, identity_map) and the
`vw_*` views that ARE the metric definitions — versioned, tested
(tests/test_metrics.py recomputes every aggregate independently). `eil eval`
records each run for the recall trend; `eil report` writes a self-contained
HTML report (docs/metrics-report.html) from the views; Grafana provisioning
for the same views lives in `observability/grafana/`.

## Development

```sh
uv run pytest          # pure-function tests need no database
uv run ruff check .
uv run python tests/test_chunker.py --regen   # after a deliberate chunker change
```

The golden files under `tests/golden/` are the determinism contract: same input,
same chunks, byte for byte, on every platform (hence `eol=lf` in .gitattributes).

## Status — phase 0

- [x] Canonical doc model, chunker (golden-tested), rule router, in-service RRF
- [x] Postgres schema: documents, chunks (FTS), links, cursors, audit
- [x] Fixture ingest for Confluence + Jira with hash gate + link extraction
- [x] MCP stdio server: search_docs / get_doc / expand, audit-logged
- [x] Live connectors (cursor-based CQL/JQL sync, personal PATs, storage-format→md)
- [x] `search_code` v0 proxying Bitbucket DC search (native repo ACLs)
- [x] LLM provider layer: maas | amp | copilot, usage logged to `llm_calls`
- [ ] Golden-query log → recall baseline (`docs/golden-queries.md`, needs real usage)
- [ ] ACL gate + per-user tokens + red-team suite (phase 2 — the rollout gate)

Live sync env (personal credentials only): `EIL_CONFLUENCE_URL/TOKEN`,
`EIL_JIRA_URL/TOKEN`, `EIL_BITBUCKET_URL/TOKEN`. Then `uv run eil ingest
confluence` (no --fixture) syncs incrementally from the stored cursor.

Local mode ingests with **your personal credentials only** — you can only index
what you can already read. Service accounts exist only on kube, after the ACL
gate (phase 2).
