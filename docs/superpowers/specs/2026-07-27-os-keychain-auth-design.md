# OS Keychain Authentication — Design

**Date:** 2026-07-27
**Status:** Approved (design), pending implementation plan

## Problem

EIL's live connectors (Jira, Confluence, Bitbucket, ELK) read personal access
tokens from environment variables (`EIL_<PREFIX>_TOKEN`). This forces users to
paste secrets into shell history, `.env` files, or exported shell state — awkward
on a work machine and easy to leak. We want tokens to live in the operating
system's own credential store on **macOS, Windows, and WSL2**, retrieved
transparently at connector-init time.

## Goals

- Store and retrieve DC connector tokens in the OS keychain.
- Work on macOS, native Windows, and WSL2 (WSL2 shares the Windows store).
- Add **no new runtime dependencies** — preserve the project's zero-install,
  pnpm-only, cross-platform-by-construction ethos.
- Keep the existing env-var path working as a fallback so nothing breaks (CI,
  scripts, headless).

## Non-Goals (YAGNI)

- LLM API keys (`EIL_MAAS_API_KEY`) and other secrets — different resolution
  path (`ts/llm/index.ts`); out of scope for v1.
- Non-secret config (`*_URL`, `*_USER`, `EIL_DATABASE_URL`) — stays env/config.
- Native Linux desktop keyrings beyond libsecret (`secret-tool`). KWallet users
  fall through to the env var.
- Encrypted-file or cloud secret backends.

## Decisions (locked with the user)

1. **Precedence — keychain wins.** Resolution order in `makeClient`:
   explicit `token` arg (test/override seam) → **OS keychain** → `EIL_<PREFIX>_TOKEN`
   env var → error.
2. **Backend — shell out to native OS tools.** No native module. Spawn the
   platform's own credential CLI.
3. **Scope — DC connector tokens only:** `EIL_JIRA_TOKEN`,
   `EIL_CONFLUENCE_TOKEN`, `EIL_BITBUCKET_TOKEN`, `EIL_ELK_TOKEN`.

## Architecture

### New module: `ts/connectors/keychain.ts`

Single-purpose, small surface:

```ts
getSecret(account: string): string | null      // resolve; null if absent OR no backend
setSecret(account: string, secret: string): void
deleteSecret(account: string): void
keychainBackend(): { name: string; available: boolean }   // diagnostics only
```

- `account` is the env-var name the entry substitutes (e.g. `EIL_JIRA_TOKEN`),
  so entries are self-describing in Keychain Access.app / Credential Manager.
- Service label is the constant `eil`.
- Detects platform once, selects a backend, shells out via
  `child_process.execFileSync`.
- **Secrets travel on stdin wherever the backend supports it** — Linux
  (`secret-tool`) and Windows/WSL2 (`powershell.exe`) both read from stdin, so
  the token never appears in `ps -ef` or Windows process-creation telemetry.
  **macOS is the known exception:** `security add-generic-password` accepts the
  secret only via the `-w <value>` argument (no stdin channel), so on macOS the
  token is briefly visible to the *same user's* process listing during a
  `login`/store. Accepted: this is the single-user local-first model, writes are
  rare, and lookups (`-w` with no value → stdout) never expose it.
- `getSecret` is **quiet on failure**: a missing entry OR an unavailable backend
  both return `null`, letting resolution fall through to the env var. Only the
  explicit `eil auth login` path surfaces backend errors loudly.

### Backend selection

| Platform | Detection | Store / lookup / delete tool |
|---|---|---|
| macOS | `process.platform === 'darwin'` | `security add-generic-password -U` / `find-generic-password -w` / `delete-generic-password` |
| Windows | `process.platform === 'win32'` | `powershell.exe` running an embedded Win32 `CredWrite`/`CredRead`/`CredDelete` P/Invoke script |
| WSL2 | `process.platform === 'linux'` **and** `/proc/version` contains `microsoft` (case-insensitive) | **bridge to Windows** — same `powershell.exe` script via WSL interop |
| Linux (native) | `linux`, not WSL | `secret-tool store/lookup/clear` (libsecret) |

Optional override: `EIL_KEYCHAIN_BACKEND` may force a backend name (used by
tests and by anyone whose auto-detection guesses wrong); default is `auto`.

### Backend command details

- **macOS `security`:**
  - store: `security add-generic-password -a <account> -s eil -U -w` with the
    secret supplied on stdin where supported, else via the `-w` value (documented
    caveat: briefly visible to the same user; acceptable on a single-user laptop).
  - lookup: `security find-generic-password -a <account> -s eil -w` (prints
    secret to stdout; nonzero exit if absent).
  - delete: `security delete-generic-password -a <account> -s eil`.
- **Linux `secret-tool`:**
  - store: `secret-tool store --label="eil <account>" service eil account <account>`
    (reads secret from stdin).
  - lookup: `secret-tool lookup service eil account <account>` (stdout; nonzero
    if absent). Requires libsecret **and** a running secret service (D-Bus).
  - delete: `secret-tool clear service eil account <account>`.
- **Windows / WSL2 `powershell.exe`:** one embedded PowerShell script,
  invoked `powershell.exe -NoProfile -NonInteractive -Command -` with the script
  (and, for writes, the secret) piped on stdin. The script P/Invokes
  `advapi32.dll` `CredWrite`/`CredRead`/`CredDelete`, target name `eil:<account>`,
  type `CRED_TYPE_GENERIC`. Works in Windows PowerShell 5.1 and PowerShell 7.
  `cmdkey` is **not** used because it cannot read a secret back.

### Resolution seam: `ts/connectors/auth.ts`

`makeClient` line 24 changes from:

```ts
const tok = token ?? required(`EIL_${prefix}_TOKEN`);
```

to a keychain-first cascade:

```ts
const tok =
  token ??
  getSecret(`EIL_${prefix}_TOKEN`) ??
  process.env[`EIL_${prefix}_TOKEN`];
if (!tok) throw new Error(
  `no ${prefix} token — run \`eil auth login ${prefix.toLowerCase()}\` or set EIL_${prefix}_TOKEN`,
);
```

This is the only connector-code change; all four connectors inherit it via
`makeClient`.

### New CLI command group: `eil auth`

```
eil auth login <jira|confluence|bitbucket|elk>   # hidden prompt for the token, store in keychain
eil auth status                                  # per-source resolved-from (keychain|env|missing) + active backend; NEVER prints secrets
eil auth logout <jira|confluence|bitbucket|elk>  # delete from keychain
```

- `login` reads the token with terminal echo disabled (Node `readline` with a
  muted output stream). A non-interactive `--stdin` option allows scripting.
- `status` is the transparency mechanism for the "keychain silently shadows an
  env var" hazard the keychain-wins precedence introduces: it names the winning
  source for each token and the active backend.
- Source name → account mapping: `jira → EIL_JIRA_TOKEN`, etc.

## Data flow

1. User runs `eil auth login jira` → hidden prompt → `setSecret('EIL_JIRA_TOKEN', tok)`
   → backend stores it in the OS keychain.
2. User runs `eil ingest jira` → `JiraClient` → `makeClient('JIRA')` →
   `getSecret('EIL_JIRA_TOKEN')` returns the stored token → Bearer header.
3. On a machine with no keychain entry, `getSecret` returns `null` and the env
   var is used, exactly as today.

## Error handling & degradation

- **Backend unavailable** (WSL without `powershell.exe`; Linux without libsecret
  or without a running secret daemon): `getSecret`/`keychainBackend().available`
  report unavailable; `getSecret` returns `null` → env-var fallback keeps working.
  `eil auth login`/`logout` fail loudly with an actionable message
  (`install libsecret-tools, or set EIL_JIRA_TOKEN`).
- **Secret never printed:** not in argv, not in logs, not in `auth status`.
- **Unknown source name** in `eil auth login <x>`: clear error listing valid
  sources.

## Testing strategy

Mirrors the repo's existing "skip if the external dependency is absent" pattern
(DB suites skip without Postgres).

- **Pure unit tests (run in CI, no real keychain):**
  - Platform → backend selection (mock `process.platform` / `/proc/version`).
  - Exact argv + stdin construction per backend (assert the spawned command).
  - `makeClient` 3-source precedence via an injected mock secret resolver:
    keychain value beats env value; env used when keychain absent; explicit
    `token` arg beats both; error when all absent.
- **Optional integration round-trip:** when `security` or `secret-tool` is
  present, `set → get → delete` against the real store; **skips** otherwise.
- CI (Linux, no secret daemon) exercises the unit tests and the env-var
  fallback; the live round-trip is a local/dev affordance.

## Documentation

- New README subsection ("Authenticating without env vars"): `eil auth login jira`
  replacing `export EIL_<PREFIX>_TOKEN`, the precedence rule (keychain → env),
  the per-OS backend one-liner, and the WSL2→Windows shared-store note.
- Update the work-machine walkthrough (step 5) to offer `eil auth login` as the
  recommended alternative to exporting tokens.
- Add `eil auth` to the Status checklist.

## Implementation risk (call out for the plan)

Windows/WSL2 **retrieval** is the fiddliest part: the embedded `CredRead`
P/Invoke PowerShell script. It is dependency-free and cross-version, but should
be built and verified hands-on first. macOS (`security`) and Linux
(`secret-tool`) are straightforward by comparison.

## Files touched

- `ts/connectors/keychain.ts` — new.
- `ts/connectors/auth.ts` — resolution cascade in `makeClient`.
- `ts/cli.ts` — new `auth` command group.
- `ts/tests/keychain.test.ts` — new (unit + optional round-trip).
- `README.md` — auth docs + Status.
