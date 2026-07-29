# Demo — your org's data, nothing installed

Runs on **PGlite**: real Postgres compiled to WASM, loaded out of `node_modules`.
No Docker, no Postgres server, no admin rights. The embedding model is vendored
in the repo, so the vector arm needs no network either.

Every step below corresponds to a node in **[docs/system-map.html](../docs/system-map.html)** —
open it alongside and walk the diagram as you go.

```sh
node demo/run.mjs --repo /path/to/your/repo --space ENG --project PAY
```

---

## Setup (once)

```sh
export EIL_CONFLUENCE_URL=https://confluence.your.org   # base URL, no /wiki, no trailing path
export EIL_JIRA_URL=https://jira.your.org
eil auth login confluence      # PAT goes to the OS keychain, never to disk
eil auth login jira
```

Then, **before you are standing in front of anyone**:

```sh
eil demo:preflight --repo /path/to/your/repo
```

It checks the backend, the model, both connectors, and the repo — and prints the
fix for anything wrong. It is read-only, so run it as often as you like. Two
things it catches that otherwise surface as raw git or HTTP errors mid-demo:

- a **stale `.eil-repos/`** — `git clone` into a non-empty directory just fails
- your repo's **actual branch**; the default is `main` and plenty of repos are `master`

## Scoping — read this before pointing it at a real instance

`--space` and `--project` are **required** for the live sources. An unscoped
Confluence sync pulls the entire instance, which is a poor first impression and
an unkind thing to do to your org's API from a laptop. Start with one space and
one project.

Connectors run on **your** personal token: you can only index what you could
already read.

---

## The walk

| # | Step | The map node it demonstrates |
|---|---|---|
| 1 | `db migrate` | *Zero-install backend* — 19 migrations, no server |
| 2 | `ingest confluence --space` | *Only the spaces you name* |
| 3 | `ingest jira --project` | *Projects scoped by* — issue links and labels become edges |
| 4 | `ingest repo` | *Clone, walk* — commit dates become recency |
| 5 | `embed backfill` | *Meaning, embedded* — local ONNX, no per-query cost |
| 6 | `ivf build` | The system **measuring its own recall** and choosing a parameter |
| 7 | `search` | *Two arms* fused by rank, plus tier and freshness |
| 8 | `search retryHandler` | *Exact terms, identifiers* — the code index, not the prose arm |
| 9 | quarantine | *Visibility lives on the document* |
| 10 | `audit` | *Every tool call lands as a row* |
| 11 | `eval:mine` | *Recall trend decides what gets built next* — the loop back over the top |
| 12 | `serve` over MCP | *Connected over MCP* — an agent pulls ranked, ACL-filtered context |

### 6 — the one to slow down on

`eil ivf build` prints two sweeps and then a decision:

```
  oversample   recall@10   (full probe: quantization loss only)
          4x   0.9367
          8x   0.9800
  -> oversample 8

  nprobe   recall@10   scanned/query
       1   0.4833           26
       8   0.9633          199
      23   0.9800          552
```

The first sweep is measured with **every** cluster probed, so there is no cluster
loss — whatever is missing is purely what binary quantization discarded. The
second then varies clusters at that oversample. **The two error sources are
separated, not confounded.**

On a small corpus it will often end with:

> No PARTIAL probe reached recall@10 >= 0.98, so IVF is not adopted and queries
> keep the exact scan.

**That is the demo working, not failing.** The gate refused an optimisation that
would have cost recall, and said so. Re-run as the corpus grows.

### 9 — quarantine, and the review step

The planted `demo/secret-page.json` contains an AWS key and a database password.
After ingest it is **not chunked at all**, so the credential never reaches the
tsvector, the embeddings, `ts_headline`, or a snippet — searching for its text
returns nothing.

On a real codebase the scanner will also flag **test fixtures and documentation**
that legitimately contain key-shaped strings. That is the interesting half:

```sh
eil quarantine list                    # rule and a 4-char hint, never the secret
eil quarantine clear <id>              # accept a false positive; it is re-chunked
```

Acceptance is keyed on the *value*, not the file — so if that file later gains a
**different** credential, it is quarantined again. Accepting one finding cannot
silently accept the next.

### 11 — why the eval loop exists

Every search in the demo was audited. `eval:mine` promotes them into a labelled
set, `eval:judge` pools and grades them. This is the answer to "how do you know
retrieval got better?" — and to why hand-maintained golden-query files stay
empty: nothing was producing usable usage records until the audit log did.

---

## Honest caveats — volunteer these

**~87% of chunks exceed the embedding model's window.** `eil audit` reports
`chunks_over_embed_window`. MiniLM stops at ~1024 characters and chunks are
3200, so the vector arm reads roughly the first third of most chunks. Retrieval
still works; the ceiling is real and the fix (matching chunk size to the model,
or a longer-context model) is gated on the eval set existing.

**The ACL is owner-only in practice.** `ingested_by` is the OS user and every
connector stamps `acl_groups` empty, so on a shared server every document would
be owned by the service account. Fail-closed, and currently delivering less than
"fail-closed ACL" implies. Fine for a single-operator demo; do not claim
multi-user visibility.

**No Grafana.** It needs Docker. `eil report --out demo/metrics.html` produces a
self-contained HTML report over the same fact tables.

---

## Reset

```sh
rm -rf .eil-demo .eil-repos demo/metrics.html demo/judgments.md
```

Everything lived in `.eil-demo/`. Nothing was installed, and nothing outside the
repo was touched.
