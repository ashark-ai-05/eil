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

Tools exposed: `search_docs` (compact ids + snippets), `get_doc` (windowed full
text), `expand` (link-graph neighborhood). Two-phase by design — search cheap,
fetch only what matters.

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
- [ ] Live connectors with personal credentials (phase 1)
- [ ] `search_code` v0 proxying Bitbucket DC search (phase 1)
- [ ] Golden-query log → recall baseline (phase 1)

Local mode ingests with **your personal credentials only** — you can only index
what you can already read. Service accounts exist only on kube, after the ACL
gate (phase 2).
