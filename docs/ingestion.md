# Ingestion

You can only ingest what you can already read — connectors run on **your**
personal credentials. Service accounts exist only on kube, after the ACL gate.

## Connecting a source

Set `EIL_CONFLUENCE_URL/TOKEN`, `EIL_JIRA_URL/TOKEN`, `EIL_BITBUCKET_URL/TOKEN`,
`EIL_ELK_URL/TOKEN` (DC PATs as Bearer; set `EIL_<PREFIX>_USER` for Basic auth
on older instances). Then:

```sh
pnpm eil ingest confluence      # no --fixture: syncs incrementally from the stored cursor
pnpm eil ingest jira
pnpm eil ingest obsidian --vault ~/path/to/vault    # your notes, curated tier
```

Re-running is always safe — content is hash-gated, so unchanged docs are no-ops.

**Deletions.** Cursor sync sees updates, not removals. Add `--reconcile` to a
run (`pnpm eil ingest jira --reconcile`) to fetch the source's full id listing
and tombstone catalog docs that no longer exist there. It's a heavier call, so
run it periodically rather than every sync. (Obsidian reconciles automatically:
the vault walk already *is* a full listing.)

## Selective ingestion

Ingest exactly what you need instead of the whole instance. Pick **one selector
family per run**; each selection re-syncs incrementally under its own cursor.

```sh
# Confluence
pnpm eil ingest confluence --space ENG,OPS                   # one or more spaces
pnpm eil ingest confluence --page 12345 --with-descendants   # a page + its subtree
pnpm eil ingest confluence --page 12345,67890                # exact pages
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

Space/project selections are incremental (own cursor per space/project); exact
`--page`/`--issue` always re-fetch the named items (hash-gated, so unchanged
docs are no-ops). `--reconcile` is **full-instance only** — a scoped listing
can't safely decide what to delete outside its scope.

## Repo / code ingestion

Ingest codebases from **git** (local clone or remote URL) or the **Bitbucket
API** as searchable `source="code"` docs. Source type is auto-detected: local
`.git/` → git clone; `bitbucket.` URL → Bitbucket API.

```sh
# a single repo
pnpm eil ingest repo https://github.com/user/repo.git
pnpm eil ingest repo https://bitbucket.org/team/repo

# a monorepo subpath (only code under apps/web/)
pnpm eil ingest repo https://github.com/user/monorepo --subpath apps/web

# branch + file globs (e.g. TypeScript only)
pnpm eil ingest repo https://github.com/user/repo --branch main \
  --include '**/*.ts' --include '**/*.tsx'

# search code, and link to Confluence/Jira via source
pnpm eil search "payment handler"
pnpm eil search "source:code transaction logic"
```

- **Incremental** via a per-repo commit-SHA cursor: later runs fetch only new
  commits, and a commit that deletes or modifies a file is reflected in the
  catalog (add / modify / delete-tombstone).
- **Code-aware chunking** uses overlapping line-windows, so context survives
  function and class boundaries and results stay line-cited.
- **Filtered**: binary files and oversize blobs are skipped automatically;
  narrow further with `--include`/`--exclude` globs or `--subpath`.

Clones land in `.eil-repos/`. Code is searchable via FTS (keywords,
identifiers) and semantically after `pnpm eil embed backfill`.

## Storing tokens in the OS keychain

Instead of exporting `EIL_<PREFIX>_TOKEN`, store each PAT in your operating
system's credential store once:

```sh
pnpm eil auth login jira        # hidden prompt; stored in the OS keychain
pnpm eil auth status            # per source: resolves from keychain / env / missing
                                # — never prints the token
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

> **Caveat:** the Windows/WSL2 CredMan path is unit-tested for shape only and
> has not been exercised against a real Windows credential store.
