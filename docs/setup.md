# Setup

Requirements everywhere: **Node 22+**, **pnpm 10+**, **PostgreSQL 16/17**, git.

Everything runs on a laptop with no Docker. Components promote to Kubernetes
per the pathway in the design docs, each behind its own gate.

## Install Postgres

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

## Non-default Postgres

Set `EIL_DATABASE_URL` (12-factor: all endpoints via env), e.g.
`postgresql://user:pass@host:5432/eil`. Anything that speaks real Postgres is a
drop-in: another local version, WSL2 apt, an org PG server, or managed
offerings (RDS, Neon, Supabase, ...).

## Can't install Postgres at all? Zero-install mode (PGlite)

**Postgres installation is not a blocker.** Set one env var and the stack runs
real Postgres (compiled to WASM, in-process, from `node_modules`) — no server,
no binaries, no admin rights, nothing beyond `pnpm install`:

```sh
export EIL_DATABASE_URL=pglite://.eil-pglite   # data dir, gitignored
pnpm eil db migrate
pnpm eil ingest confluence --fixture tests/fixtures/confluence_page.json
pnpm eil search "PAY-981"                      # everything works identically
```

Because PGlite *is* Postgres, migrations, FTS, the jsonb ACL predicate, and the
metrics views run unchanged — `ts/tests/pglite.test.ts` proves the full
pipeline on this backend in CI.

### Concurrency decision rule

PGlite is one process at a time — EIL enforces this with a pidfile lock (PGlite
itself would silently allow concurrent access, which is worse; a second process
gets a clear "in use by pid N" error). Fine for bootstrap and sequential use
(migrate, ingest, then serve). The moment two things must run at once (MCP
server answering while an ingest runs), switch tiers — it's only an env-var
change, no code:

| Tier | Concurrent processes | Install rights |
|---|---|---|
| `pglite://<dir>` | no (exclusive lock) | none — pnpm only |
| `pnpm eil db embedded` (optional embedded-postgres, Linux/WSL2) | **yes** — real PG server as your user | none; reinstall without `--no-optional` if unavailable |
| apt-in-WSL2 / brew | yes | sudo in your distro / brew |
| org dev PG server (`EIL_DATABASE_URL=...`) | yes | none — ask for a schema |

Note the darwin-arm64 embedded binaries are broken upstream (missing ICU
dylib) — on macOS use brew; embedded is the Linux/WSL2 no-admin concurrency
tier, which is exactly the work-machine case. Kube promotion targets server
Postgres via a normal DSN either way.

---

# Rolling out on a work machine

Windows work machine → do everything inside **WSL2**. The sequence is
deliberately staged: prove the stack with fixtures before any org system is
touched.

## 1. Prerequisites (once)

```sh
# inside WSL2 Ubuntu (or any Linux)
sudo apt install postgresql-17 git            # or postgresql + postgresql-contrib
corepack enable && corepack prepare pnpm@10 --activate   # pnpm via Node's corepack
node --version                                 # need 22+
sudo service postgresql start && sudo -u postgres createuser -s $USER
createdb eil
```

## 2. Get the code

If github.com is reachable: `git clone https://github.com/ashark-ai-05/eil.git`.
If it's blocked, bundle on the personal machine and carry the file over:

```sh
# personal machine:
git bundle create eil.bundle main
# work machine:
git clone eil.bundle eil && cd eil && git remote remove origin
```

## 3. Prove the stack offline — no org access needed

```sh
pnpm install
pnpm eil db migrate
pnpm test                       # DB suites run against your local PG
pnpm eil ingest confluence --fixture tests/fixtures/confluence_page.json
pnpm eil ingest jira --fixture tests/fixtures/jira_issue.json
pnpm eil search "PAY-981"       # entity route + link graph must work
```

Green here means the environment is sound. Only now touch real systems.

## 4. Corporate network realities (read before step 5)

- **Proxy**: Node's fetch does not honor `HTTPS_PROXY` by default. On Node 24+
  set `NODE_USE_ENV_PROXY=1`; otherwise export a global undici EnvHttpProxyAgent
  or run where the proxy is transparent.
- **Corporate CA**: TLS interception breaks fetch with self-signed-chain errors.
  Point Node at the corp root: `export NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem`.
  Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **Old DC instances**: if a PAT gets 401s, the instance may predate PAT
  support — set `EIL_<PREFIX>_USER=<username>` to switch that connector to
  Basic auth.

## 5. Create personal access tokens

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
keychain instead — see [ingestion.md](ingestion.md#storing-tokens-in-the-os-keychain).

## 6. First live sync — seed the cursor first

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

## 7. Validate against real content

```sh
pnpm eil search "<something you know is on the wiki>"
pnpm eil search "<a real ticket key>"          # entity route + linked context
pnpm eil audit --drift 20                      # sync faithful? sample + live-compare
```

Spot-check conversion quality: `get_doc` a page you know well and compare with
the real thing — the storage-format→markdown converter meeting your wiki's
macros for the first time is the likeliest place to find bugs. File samples of
any mangled pages; the normalizer has a test corpus for exactly this.

## 8. Wire into your MCP client or connector

See [mcp.md](mcp.md).

## 9. Start the feedback loops

Log real queries in `golden-queries.md` (query → expected doc id) as you use
it; run `pnpm eil eval` to baseline recall on real data; `pnpm eil report`
shows adoption, zero-result rate, and the two-phase ratio — that data schedules
everything that gets built next.
