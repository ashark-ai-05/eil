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

### Porting to another MCP host (e.g. a tool-discovery connector)

The tool surface is defined once, framework-free, in `src/eil/tools.py`:
`REGISTRY` maps name → `ToolSpec(name, description, parameters JSON-schema,
handler, requires_env)`, and `tools.call_tool(name, args, viewer)` is the
single dispatch point (env gating, ACL viewer, audit logging). `mcp_server.py`
is just a thin FastMCP mount over it. To host these tools from a different
connector: read `REGISTRY` for discovery metadata, dispatch through
`call_tool` — no FastMCP dependency, no logic changes. Config is entirely
env-vars (12-factor), so the same code runs wherever the env points it.

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
