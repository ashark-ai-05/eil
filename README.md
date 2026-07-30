# EIL — Enterprise Intelligence Layer

Deterministic, **token-free** retrieval over org knowledge — Confluence, Jira,
code, notes — served to agents over MCP.

Agents burn tokens rediscovering the same context. EIL indexes it once into a
single Postgres, then answers with a plain query: no LLM in the hot loop, no
tokens spent searching, the same results every time. Runs entirely on a laptop,
no Docker.

```sh
pnpm install
pnpm eil db migrate
pnpm eil ingest confluence --fixture tests/fixtures/confluence_page.json
pnpm eil search "how do payment retries work"
```

No Postgres? `export EIL_DATABASE_URL=pglite://.eil-pglite` runs real Postgres
in-process, from `node_modules`, with no server and no admin rights.

**Requirements:** Node 22+, pnpm 10+, PostgreSQL 16/17 (or the PGlite line
above). Full install steps: **[docs/setup.md](docs/setup.md)**.

## Use it from an agent

EIL is a standard stdio MCP server:

```sh
claude mcp add eil-knowledge -- pnpm -s --dir /path/to/eil eil serve
```

It exposes five tools — `search_docs`, `get_doc`, `expand`, `search_code`,
`fetch_logs` — and is two-phase by design: search returns ids and snippets, and
the agent fetches only what it actually needs.

To mount those tools inside **your own TypeScript MCP server** instead of
running a second one:

```ts
import { REGISTRY, callTool } from "eil/tools";

for (const spec of Object.values(REGISTRY)) {
  server.tool(spec.name, spec.description, spec.schema.shape, async (args: any) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await callTool(spec.name, args, viewer)) }],
  }));
}
```

`callTool()` is the single choke point — env gating, argument validation, ACL
viewer, and audit logging all live there, so you inherit them. Amp and VS Code
configs, router/aggregator setups, per-request identity, and connection reuse:
**[docs/mcp.md](docs/mcp.md)**.

## Getting your knowledge in

```sh
pnpm eil ingest confluence --space ENG,OPS
pnpm eil ingest jira --project PAY
pnpm eil ingest repo https://github.com/user/repo.git --include '**/*.ts'
pnpm eil ingest obsidian --vault ~/notes
```

Connectors run on **your** personal credentials — you can only index what you
could already read. Syncs are incremental from a stored cursor and hash-gated,
so re-running is free. Scoping flags, deletions, code ingestion, and OS-keychain
token storage: **[docs/ingestion.md](docs/ingestion.md)**.

## Gating what an agent produces

```sh
# The gate re-reads every cited document out of the catalog, so point at one:
export EIL_DATABASE_URL=pglite://.eil-demo

pnpm eil reqs check demo/PTR-401.reqs.json          # the gate: 46 checks, exit 1 on refusal
pnpm eil reqs check demo/PTR-401.reqs.json --json   # the same result as machine-readable JSON
pnpm eil reqs check demo/PTR-401.reqs.json --mode lint   # GATE family downgraded, for mid-loop use
pnpm eil reqs render demo/PTR-401.reqs.json         # project it as self-contained HTML
pnpm eil reqs render demo/PTR-401.reqs.json --markdown
```

A `reqs.json` is a requirements artefact with every derived field generated
rather than authored, so editing one is detectable: `check` recomputes them all,
re-reads every cited quote out of the catalog, and refuses by name. `render`
stamps a refused artefact **REFUSED** rather than projecting it as a clean
document. `node demo/tamper.mjs` demonstrates six single-field edits and the six
checks that catch them.

## What you get

- **Fail-closed ACL on every read.** Visibility is stamped on the document, not
  asked of the query. An unstamped doc is owner-only, so a bug fails *closed*.
- **Deterministic.** Four lexical arms — strict and loose Postgres full-text,
  over prose and over the code index — plus a vector arm when the local model is
  available, fused with reciprocal-rank fusion. Same query, same corpus, same
  order. No LLM in the retrieval path.
- **Incremental.** Cursor sync, content hashing, and delete-tombstones, so
  results can't outlive their source.
- **One Postgres, no extension.** PGlite, embedded PG, system PG, or an org
  DSN. No `CREATE EXTENSION`, no Docker, no admin.
- **Auditable.** Every tool and model call is a logged row, and metrics are SQL
  views over those facts rather than a dashboard's interpretation of them.

Semantic search, data-trust auditing, metrics and development workflow:
**[docs/operations.md](docs/operations.md)**.

## Architecture

**[docs/system-map.html](docs/system-map.html)** — the whole ecosystem in one
interactive diagram; open any node to expand it. Partly generated from the
code, so it can't silently drift.

Also: [architecture-schematic.html](docs/architecture-schematic.html) (the
pipeline stage by stage), [eil-architecture.html](docs/eil-architecture.html)
(full solution), [knowledge-plane.html](docs/knowledge-plane.html) and
[observability-plane.html](docs/observability-plane.html) (design notes).

## Status

Shipped: full TypeScript port (golden-verified against the Python original) ·
canonical model, chunker, router, RRF, tier/recency ranking · fail-closed ACL
with an 11-scenario red-team suite · live connectors with selective ingestion ·
repo/code ingestion with commit-SHA incremental sync · semantic search
(`float4[]` dot product scored in SQL) · OS keychain auth · metrics schema,
views, eval trend, HTML report, Grafana provisioning · data-trust audit
(CI-gated integrity + live drift sampling) · zero-install PGlite backend.

In progress:

- [ ] Golden-query log growth from real usage (`docs/golden-queries.md`)
- [ ] Per-user tokens + HTTP MCP transport (phase 2 — the kube rollout gate)
- [ ] Sub-linear vector scoring (LSH sketch column) — scoring is currently a
      linear scan, fine at personal scale
