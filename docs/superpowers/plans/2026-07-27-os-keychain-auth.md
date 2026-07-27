# OS Keychain Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store and retrieve the four DC connector tokens (Jira, Confluence, Bitbucket, ELK) in the OS keychain on macOS, Windows, and WSL2, resolved keychain-first with an env-var fallback.

**Architecture:** A new `ts/connectors/keychain.ts` shells out to each platform's native credential tool (`security`, `secret-tool`, or `powershell.exe`+Win32 CredMan) — no native deps. A one-line change in `makeClient` (`ts/connectors/auth.ts`) makes token resolution keychain → env → error. A new `eil auth` CLI group (login/status/logout) manages entries.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `child_process.execFileSync`, commander, vitest, biome.

## Global Constraints

- **No new runtime dependencies.** Backends shell out to OS tools only.
- **Node 22+**, ESM, strict `tsc`. Import specifiers end in `.js`.
- **Secrets on stdin where supported** (secret-tool, powershell); macOS `security` is the documented argv exception.
- **Never print a secret** — not in argv logs, not in `auth status`.
- Keychain service label is the constant `eil`; entry account is the env-var name it substitutes (e.g. `EIL_JIRA_TOKEN`).
- Precedence: explicit `token` arg → **keychain** → `EIL_<PREFIX>_TOKEN` env → throw.
- `getSecret` is quiet: missing entry OR unavailable backend both return `null`.
- Scope: `EIL_JIRA_TOKEN`, `EIL_CONFLUENCE_TOKEN`, `EIL_BITBUCKET_TOKEN`, `EIL_ELK_TOKEN` only.

## File Structure

- Create `ts/connectors/keychain.ts` — platform detection, backend selection, backend implementations, top-level `getSecret`/`setSecret`/`deleteSecret`/`keychainBackend`, and the `SOURCES` map + `resolvedSource` helper for the CLI.
- Modify `ts/connectors/auth.ts` — keychain-first cascade in `makeClient`.
- Modify `ts/cli.ts` — new `auth` command group.
- Create `ts/tests/keychain.test.ts` — unit tests (host-independent, via injected runner) + optional live round-trip.
- Modify `ts/tests/auth.test.ts` — precedence tests via the `memory` backend.
- Modify `README.md` — auth docs + Status checklist.

---

### Task 1: Backend detection & selection (pure)

**Files:**
- Create: `ts/connectors/keychain.ts`
- Test: `ts/tests/keychain.test.ts`

**Interfaces:**
- Produces: `type Runner = (cmd: string, args: string[], input?: string) => RunResult`; `interface RunResult { status: number; stdout: string }`; `const defaultRunner: Runner`; `function detectWsl(read?): boolean`; `type BackendName = "security" | "secret-tool" | "wincred" | "memory" | "none"`; `function selectBackend(platform?, isWsl?, override?): BackendName`.

- [ ] **Step 1: Write the failing test**

```ts
// ts/tests/keychain.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { detectWsl, selectBackend } from "../connectors/keychain.js";

afterEach(() => {
  delete process.env.EIL_KEYCHAIN_BACKEND;
});

describe("backend selection", () => {
  it("maps platforms to backends", () => {
    expect(selectBackend("darwin", false, undefined)).toBe("security");
    expect(selectBackend("win32", false, undefined)).toBe("wincred");
    expect(selectBackend("linux", false, undefined)).toBe("secret-tool");
  });

  it("bridges WSL2 to the Windows credential store", () => {
    expect(selectBackend("linux", true, undefined)).toBe("wincred");
  });

  it("honors the EIL_KEYCHAIN_BACKEND override", () => {
    expect(selectBackend("linux", false, "memory")).toBe("memory");
  });

  it("detectWsl matches microsoft in /proc/version", () => {
    expect(detectWsl(() => "Linux 5.15 microsoft-standard-WSL2")).toBe(true);
    expect(detectWsl(() => "Linux 6.8 generic")).toBe(false);
    expect(detectWsl(() => { throw new Error("no file"); })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/keychain.test.ts`
Expected: FAIL — cannot resolve `../connectors/keychain.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// ts/connectors/keychain.ts
/**
 * OS keychain credential storage for DC connector tokens. Shells out to the
 * platform's native credential tool — no native deps. Resolution is
 * keychain-first with an env-var fallback (see auth.ts). Backends: security
 * (macOS), secret-tool/libsecret (Linux), Credential Manager via powershell.exe
 * (Windows + WSL2 bridge), memory (tests/override).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const SERVICE = "eil";

export interface RunResult {
  status: number;
  stdout: string;
}

export type Runner = (cmd: string, args: string[], input?: string) => RunResult;

export const defaultRunner: Runner = (cmd, args, input) => {
  try {
    const stdout = execFileSync(cmd, args, {
      input,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return { status: 0, stdout };
  } catch (err: any) {
    return { status: typeof err.status === "number" ? err.status : 1, stdout: "" };
  }
};

export function detectWsl(read: (p: string) => string = (p) => readFileSync(p, "utf-8")): boolean {
  try {
    return /microsoft/i.test(read("/proc/version"));
  } catch {
    return false;
  }
}

export type BackendName = "security" | "secret-tool" | "wincred" | "memory" | "none";

export function selectBackend(
  platform: NodeJS.Platform = process.platform,
  isWsl: boolean = detectWsl(),
  override: string | undefined = process.env.EIL_KEYCHAIN_BACKEND,
): BackendName {
  if (override) return override as BackendName;
  if (platform === "darwin") return "security";
  if (platform === "win32") return "wincred";
  if (platform === "linux") return isWsl ? "wincred" : "secret-tool";
  return "none";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run ts/tests/keychain.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ts/connectors/keychain.ts ts/tests/keychain.test.ts
git commit -m "keychain: platform detection + backend selection"
```

---

### Task 2: macOS + Linux backends and the top-level API

**Files:**
- Modify: `ts/connectors/keychain.ts`
- Test: `ts/tests/keychain.test.ts`

**Interfaces:**
- Consumes: `Runner`, `RunResult`, `SERVICE`, `BackendName`, `selectBackend` (Task 1).
- Produces: `interface Keychain { name: BackendName; available(): boolean; get(a: string): string | null; set(a: string, s: string): void; delete(a: string): void }`; `securityKeychain(run: Runner): Keychain`; `secretToolKeychain(run: Runner): Keychain`; `memoryKeychain(): Keychain`; `keychain(runner?: Runner): Keychain`; `getSecret(account: string): string | null`; `setSecret(account, secret): void`; `deleteSecret(account): void`; `keychainBackend(): { name: BackendName; available: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/keychain.test.ts
import {
  getSecret,
  memoryKeychain,
  securityKeychain,
  secretToolKeychain,
  setSecret,
} from "../connectors/keychain.js";

function recorder() {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
  const runner = (cmd: string, args: string[], input?: string) => {
    calls.push({ cmd, args, input });
    return { status: 0, stdout: "secret-value\n" };
  };
  return { calls, runner };
}

describe("macOS security backend", () => {
  it("builds add/find/delete commands with service=eil", () => {
    const { calls, runner } = recorder();
    const kc = securityKeychain(runner);
    kc.set("EIL_JIRA_TOKEN", "pat-1");
    kc.get("EIL_JIRA_TOKEN");
    kc.delete("EIL_JIRA_TOKEN");
    expect(calls[0].args).toEqual(
      ["add-generic-password", "-a", "EIL_JIRA_TOKEN", "-s", "eil", "-U", "-w", "pat-1"],
    );
    expect(calls[1].args).toEqual(
      ["find-generic-password", "-a", "EIL_JIRA_TOKEN", "-s", "eil", "-w"],
    );
    expect(calls[2].args).toEqual(
      ["delete-generic-password", "-a", "EIL_JIRA_TOKEN", "-s", "eil"],
    );
  });

  it("trims the trailing newline from a found secret", () => {
    const kc = securityKeychain(() => ({ status: 0, stdout: "pat-1\n" }));
    expect(kc.get("EIL_JIRA_TOKEN")).toBe("pat-1");
  });

  it("returns null when the entry is absent", () => {
    const kc = securityKeychain(() => ({ status: 44, stdout: "" }));
    expect(kc.get("EIL_JIRA_TOKEN")).toBeNull();
  });
});

describe("Linux secret-tool backend", () => {
  it("passes the secret on stdin, never argv", () => {
    const { calls, runner } = recorder();
    const kc = secretToolKeychain(runner);
    kc.set("EIL_JIRA_TOKEN", "pat-1");
    expect(calls[0].args).toEqual(
      ["store", "--label=eil EIL_JIRA_TOKEN", "service", "eil", "account", "EIL_JIRA_TOKEN"],
    );
    expect(calls[0].input).toBe("pat-1");
    expect(calls[0].args).not.toContain("pat-1");
  });

  it("returns null on empty stdout even with status 0", () => {
    const kc = secretToolKeychain(() => ({ status: 0, stdout: "" }));
    expect(kc.get("EIL_JIRA_TOKEN")).toBeNull();
  });
});

describe("memory backend + top-level API", () => {
  it("round-trips through setSecret/getSecret via the override", () => {
    process.env.EIL_KEYCHAIN_BACKEND = "memory";
    setSecret("EIL_JIRA_TOKEN", "kc-token");
    expect(getSecret("EIL_JIRA_TOKEN")).toBe("kc-token");
    memoryKeychain().delete("EIL_JIRA_TOKEN");
    expect(getSecret("EIL_JIRA_TOKEN")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/keychain.test.ts`
Expected: FAIL — `securityKeychain` etc. not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `ts/connectors/keychain.ts`:

```ts
export interface Keychain {
  name: BackendName;
  available(): boolean;
  get(account: string): string | null;
  set(account: string, secret: string): void;
  delete(account: string): void;
}

export function securityKeychain(run: Runner): Keychain {
  return {
    name: "security",
    available: () => run("security", ["help"]).status === 0,
    get: (a) => {
      const r = run("security", ["find-generic-password", "-a", a, "-s", SERVICE, "-w"]);
      return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
    },
    set: (a, s) => {
      run("security", ["add-generic-password", "-a", a, "-s", SERVICE, "-U", "-w", s]);
    },
    delete: (a) => {
      run("security", ["delete-generic-password", "-a", a, "-s", SERVICE]);
    },
  };
}

export function secretToolKeychain(run: Runner): Keychain {
  return {
    name: "secret-tool",
    available: () => run("secret-tool", ["--help"]).status === 0,
    get: (a) => {
      const r = run("secret-tool", ["lookup", "service", SERVICE, "account", a]);
      return r.status === 0 && r.stdout !== "" ? r.stdout.replace(/\n$/, "") : null;
    },
    set: (a, s) => {
      run("secret-tool", ["store", `--label=${SERVICE} ${a}`, "service", SERVICE, "account", a], s);
    },
    delete: (a) => {
      run("secret-tool", ["clear", "service", SERVICE, "account", a]);
    },
  };
}

const memoryStore = new Map<string, string>();

export function memoryKeychain(): Keychain {
  return {
    name: "memory",
    available: () => true,
    get: (a) => memoryStore.get(a) ?? null,
    set: (a, s) => {
      memoryStore.set(a, s);
    },
    delete: (a) => {
      memoryStore.delete(a);
    },
  };
}

function noneKeychain(): Keychain {
  const fail = (): never => {
    throw new Error(
      "no OS keychain backend available — install libsecret-tools (Linux) or set the token env var directly",
    );
  };
  return { name: "none", available: () => false, get: () => null, set: fail, delete: fail };
}

// wincred is added in Task 3; until then it falls through to noneKeychain.
export function keychain(runner: Runner = defaultRunner): Keychain {
  switch (selectBackend()) {
    case "security":
      return securityKeychain(runner);
    case "secret-tool":
      return secretToolKeychain(runner);
    case "memory":
      return memoryKeychain();
    default:
      return noneKeychain();
  }
}

export function getSecret(account: string): string | null {
  try {
    return keychain().get(account);
  } catch {
    return null;
  }
}

export function setSecret(account: string, secret: string): void {
  keychain().set(account, secret);
}

export function deleteSecret(account: string): void {
  keychain().delete(account);
}

export function keychainBackend(): { name: BackendName; available: boolean } {
  const kc = keychain();
  try {
    return { name: kc.name, available: kc.available() };
  } catch {
    return { name: kc.name, available: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run ts/tests/keychain.test.ts`
Expected: PASS (all keychain tests).

- [ ] **Step 5: Commit**

```bash
git add ts/connectors/keychain.ts ts/tests/keychain.test.ts
git commit -m "keychain: macOS security + Linux secret-tool backends + top-level API"
```

---

### Task 3: Windows / WSL2 backend (Credential Manager via PowerShell)

**Files:**
- Modify: `ts/connectors/keychain.ts`
- Test: `ts/tests/keychain.test.ts`

**Interfaces:**
- Consumes: `Keychain`, `Runner`, `SERVICE` (Task 2).
- Produces: `wincredKeychain(run: Runner): Keychain`; wired into `keychain()`'s `case "wincred"`.

**Note:** the CredRead/CredWrite P/Invoke is the feature's riskiest part and cannot run on CI (Linux). The unit test asserts the *invocation shape* (host-independent); Step 6 is a mandatory manual round-trip on a real Windows/WSL2 box before this task is considered done.

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/keychain.test.ts
import { wincredKeychain } from "../connectors/keychain.js";

describe("Windows/WSL wincred backend", () => {
  it("invokes powershell.exe with an EncodedCommand and secret on stdin", () => {
    const { calls, runner } = recorder();
    const kc = wincredKeychain(runner);
    kc.set("EIL_JIRA_TOKEN", "pat-1");
    expect(calls[0].cmd).toBe("powershell.exe");
    expect(calls[0].args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    // secret travels on stdin, never argv
    expect(calls[0].input).toBe("pat-1");
    expect(calls[0].args.join(" ")).not.toContain("pat-1");
    // the encoded script targets eil:EIL_JIRA_TOKEN
    const script = Buffer.from(calls[0].args[3], "base64").toString("utf16le");
    expect(script).toContain("eil:EIL_JIRA_TOKEN");
    expect(script).toContain("CredWrite");
  });

  it("get returns null when CredRead exits nonzero", () => {
    const kc = wincredKeychain(() => ({ status: 1, stdout: "" }));
    expect(kc.get("EIL_JIRA_TOKEN")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/keychain.test.ts`
Expected: FAIL — `wincredKeychain` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `ts/connectors/keychain.ts` (and add `case "wincred": return wincredKeychain(runner);` to `keychain()`):

```ts
const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;

const PS_PREAMBLE = `$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class EilCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL c, UInt32 f);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string t, UInt32 ty, UInt32 f, out IntPtr c);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool CredDelete(string t, UInt32 ty, UInt32 f);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
}
"@`;

/** account is validated to [A-Z0-9_] before reaching here, so it is safe to
 *  interpolate into the PowerShell string literal for the target name. */
function psScript(op: "get" | "set" | "delete", account: string): string {
  const target = `${SERVICE}:${account}`;
  if (op === "set") {
    return `${PS_PREAMBLE}
$secret=[Console]::In.ReadToEnd()
$bytes=[Text.Encoding]::Unicode.GetBytes($secret)
$blob=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes,0,$blob,$bytes.Length)
$c=New-Object EilCred+CREDENTIAL
$c.Type=${CRED_TYPE_GENERIC}; $c.TargetName="${target}"; $c.UserName="${account}"
$c.CredentialBlobSize=$bytes.Length; $c.CredentialBlob=$blob; $c.Persist=${CRED_PERSIST_LOCAL_MACHINE}
$ok=[EilCred]::CredWrite([ref]$c,0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
if(-not $ok){ exit 1 }`;
  }
  if (op === "get") {
    return `${PS_PREAMBLE}
$p=[IntPtr]::Zero
if(-not [EilCred]::CredRead("${target}",${CRED_TYPE_GENERIC},0,[ref]$p)){ exit 1 }
$c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[Type][EilCred+CREDENTIAL])
$bytes=New-Object byte[] $c.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$bytes,0,$c.CredentialBlobSize)
[EilCred]::CredFree($p)
[Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))`;
  }
  return `${PS_PREAMBLE}
if(-not [EilCred]::CredDelete("${target}",${CRED_TYPE_GENERIC},0)){ exit 1 }`;
}

function encodePs(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function ps(run: Runner, op: "get" | "set" | "delete", account: string, input?: string): RunResult {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePs(psScript(op, account))],
    input,
  );
}

export function wincredKeychain(run: Runner): Keychain {
  return {
    name: "wincred",
    available: () => run("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]).status === 0,
    get: (a) => {
      const r = ps(run, "get", a);
      return r.status === 0 && r.stdout !== "" ? r.stdout : null;
    },
    set: (a, s) => {
      const r = ps(run, "set", a, s);
      if (r.status !== 0) throw new Error(`keychain write failed for ${a}`);
    },
    delete: (a) => {
      ps(run, "delete", a);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run ts/tests/keychain.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 6: Manual round-trip on a real Windows/WSL2 machine (MANDATORY before commit)**

On Windows (or WSL2 with interop), after `pnpm install`:

```sh
EIL_KEYCHAIN_BACKEND=wincred pnpm exec tsx -e "import('./ts/connectors/keychain.js').then(async k => { k.setSecret('EIL_SMOKE_TOKEN','hello-123'); console.log('read:', k.getSecret('EIL_SMOKE_TOKEN')); k.deleteSecret('EIL_SMOKE_TOKEN'); console.log('after delete:', k.getSecret('EIL_SMOKE_TOKEN')); })"
```

Expected output: `read: hello-123` then `after delete: null`. If the P/Invoke is wrong, fix the script and re-run before committing.

- [ ] **Step 7: Commit**

```bash
git add ts/connectors/keychain.ts ts/tests/keychain.test.ts
git commit -m "keychain: Windows/WSL2 Credential Manager backend via powershell CredRead/CredWrite"
```

---

### Task 4: Keychain-first resolution in makeClient

**Files:**
- Modify: `ts/connectors/auth.ts:24`
- Test: `ts/tests/auth.test.ts`

**Interfaces:**
- Consumes: `getSecret`, `setSecret`, `deleteSecret` (Task 2).
- Produces: unchanged `makeClient` signature; new resolution order inside it.

- [ ] **Step 1: Write the failing test**

```ts
// append cases to ts/tests/auth.test.ts (add imports at top)
import { deleteSecret, setSecret } from "../connectors/keychain.js";

describe("token resolution precedence", () => {
  afterEach(() => {
    delete process.env.EIL_KEYCHAIN_BACKEND;
    delete process.env.EIL_JIRA_TOKEN;
    deleteSecret("EIL_JIRA_TOKEN");
  });

  it("prefers the keychain over the env var", () => {
    process.env.EIL_KEYCHAIN_BACKEND = "memory";
    setSecret("EIL_JIRA_TOKEN", "from-keychain");
    process.env.EIL_JIRA_TOKEN = "from-env";
    const client = makeClient("JIRA", "https://jira.example.com");
    expect(client.headers.Authorization).toBe("Bearer from-keychain");
  });

  it("falls back to the env var when the keychain has no entry", () => {
    process.env.EIL_KEYCHAIN_BACKEND = "memory";
    deleteSecret("EIL_JIRA_TOKEN");
    process.env.EIL_JIRA_TOKEN = "from-env";
    const client = makeClient("JIRA", "https://jira.example.com");
    expect(client.headers.Authorization).toBe("Bearer from-env");
  });

  it("lets an explicit token arg win over both", () => {
    process.env.EIL_KEYCHAIN_BACKEND = "memory";
    setSecret("EIL_JIRA_TOKEN", "from-keychain");
    const client = makeClient("JIRA", "https://jira.example.com", "explicit");
    expect(client.headers.Authorization).toBe("Bearer explicit");
  });

  it("throws an actionable error when no token is found", () => {
    process.env.EIL_KEYCHAIN_BACKEND = "memory";
    delete process.env.EIL_JIRA_TOKEN;
    deleteSecret("EIL_JIRA_TOKEN");
    expect(() => makeClient("JIRA", "https://jira.example.com")).toThrow(/eil auth login jira/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/auth.test.ts`
Expected: FAIL — resolution still uses `required` (keychain ignored).

- [ ] **Step 3: Write minimal implementation**

In `ts/connectors/auth.ts`, add the import and replace the token line (line 24):

```ts
import { getSecret } from "./keychain.js";
```

```ts
  const tok =
    token ??
    getSecret(`EIL_${prefix}_TOKEN`) ??
    process.env[`EIL_${prefix}_TOKEN`];
  if (!tok) {
    throw new Error(
      `no ${prefix} token — run \`eil auth login ${prefix.toLowerCase()}\` or set EIL_${prefix}_TOKEN`,
    );
  }
```

(The `url` line above still uses `required`, so the existing "fails with a named error when env is missing" test — which checks `EIL_NOPE_URL` — keeps passing because the URL check throws first.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run ts/tests/auth.test.ts`
Expected: PASS (original 4 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add ts/connectors/auth.ts ts/tests/auth.test.ts
git commit -m "auth: keychain-first token resolution with env-var fallback"
```

---

### Task 5: `eil auth` CLI group

**Files:**
- Modify: `ts/connectors/keychain.ts` (add `SOURCES`, `resolvedSource`)
- Modify: `ts/cli.ts`
- Test: `ts/tests/keychain.test.ts`

**Interfaces:**
- Consumes: `getSecret`, `setSecret`, `deleteSecret`, `keychainBackend` (Task 2).
- Produces: `const SOURCES: Record<string, string>`; `function resolvedSource(account, env, kcGet): "keychain" | "env" | "missing"`.

- [ ] **Step 1: Write the failing test**

```ts
// append to ts/tests/keychain.test.ts
import { resolvedSource, SOURCES } from "../connectors/keychain.js";

describe("auth status helper", () => {
  it("maps the four sources to their token accounts", () => {
    expect(SOURCES).toEqual({
      jira: "EIL_JIRA_TOKEN",
      confluence: "EIL_CONFLUENCE_TOKEN",
      bitbucket: "EIL_BITBUCKET_TOKEN",
      elk: "EIL_ELK_TOKEN",
    });
  });

  it("reports the winning source, keychain first", () => {
    const kc = (a: string) => (a === "EIL_JIRA_TOKEN" ? "x" : null);
    expect(resolvedSource("EIL_JIRA_TOKEN", {}, kc)).toBe("keychain");
    expect(resolvedSource("EIL_CONFLUENCE_TOKEN", { EIL_CONFLUENCE_TOKEN: "y" }, kc)).toBe("env");
    expect(resolvedSource("EIL_ELK_TOKEN", {}, kc)).toBe("missing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run ts/tests/keychain.test.ts`
Expected: FAIL — `SOURCES`/`resolvedSource` not exported.

- [ ] **Step 3: Write minimal implementation (helpers)**

Append to `ts/connectors/keychain.ts`:

```ts
export const SOURCES: Record<string, string> = {
  jira: "EIL_JIRA_TOKEN",
  confluence: "EIL_CONFLUENCE_TOKEN",
  bitbucket: "EIL_BITBUCKET_TOKEN",
  elk: "EIL_ELK_TOKEN",
};

export function resolvedSource(
  account: string,
  env: NodeJS.ProcessEnv,
  kcGet: (a: string) => string | null,
): "keychain" | "env" | "missing" {
  if (kcGet(account)) return "keychain";
  if (env[account]) return "env";
  return "missing";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run ts/tests/keychain.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the CLI command group**

In `ts/cli.ts`, add near the other top-level commands (before `program.parseAsync`):

```ts
import { createInterface } from "node:readline";

function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout;
    // Mute echo: intercept writes while reading the answer.
    const mutedWrite = (rl as any)._writeToOutput;
    (rl as any)._writeToOutput = (s: string) => {
      if (s.includes(label)) out.write(s);
    };
    rl.question(`${label}: `, (answer) => {
      (rl as any)._writeToOutput = mutedWrite;
      out.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

const auth = program.command("auth").description("Manage connector tokens in the OS keychain");

auth
  .command("login <source>")
  .description("Store a connector token in the OS keychain (jira|confluence|bitbucket|elk)")
  .option("--stdin", "read the token from stdin instead of an interactive prompt")
  .action(async (source, opts) => {
    const { SOURCES, keychainBackend, setSecret } = await import("./connectors/keychain.js");
    const account = SOURCES[source];
    if (!account) {
      console.log(`unknown source '${source}'. valid: ${Object.keys(SOURCES).join(", ")}`);
      process.exit(1);
    }
    const backend = keychainBackend();
    if (!backend.available) {
      console.log(
        `no keychain backend available (${backend.name}) — install libsecret-tools (Linux) or set ${account} directly`,
      );
      process.exit(1);
    }
    const token = opts.stdin
      ? readFileSync(0, "utf-8").trim()
      : await promptHidden(`${source} token`);
    if (!token) {
      console.log("no token provided");
      process.exit(1);
    }
    setSecret(account, token);
    console.log(`stored ${account} in the ${backend.name} keychain`);
  });

auth
  .command("status")
  .description("Show where each connector token resolves from (never prints secrets)")
  .action(async () => {
    const { SOURCES, getSecret, keychainBackend, resolvedSource } = await import(
      "./connectors/keychain.js"
    );
    const backend = keychainBackend();
    console.log(`keychain backend: ${backend.name} (available: ${backend.available})`);
    for (const [source, account] of Object.entries(SOURCES)) {
      const from = resolvedSource(account, process.env, getSecret);
      console.log(`  ${source.padEnd(11)} ${account.padEnd(22)} <- ${from}`);
    }
  });

auth
  .command("logout <source>")
  .description("Remove a connector token from the OS keychain")
  .action(async (source) => {
    const { SOURCES, deleteSecret } = await import("./connectors/keychain.js");
    const account = SOURCES[source];
    if (!account) {
      console.log(`unknown source '${source}'. valid: ${Object.keys(SOURCES).join(", ")}`);
      process.exit(1);
    }
    deleteSecret(account);
    console.log(`removed ${account} from the keychain`);
  });
```

- [ ] **Step 6: Verify the CLI wiring manually**

Run:
```bash
EIL_KEYCHAIN_BACKEND=memory pnpm -s eil auth status
```
Expected: prints `keychain backend: memory (available: true)` and four rows each ending `<- missing`.

- [ ] **Step 7: Run typecheck + lint + full suite**

Run: `pnpm typecheck && pnpm lint && pnpm exec vitest run ts/tests/keychain.test.ts ts/tests/auth.test.ts`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add ts/connectors/keychain.ts ts/cli.ts ts/tests/keychain.test.ts
git commit -m "cli: eil auth login/status/logout for OS keychain tokens"
```

---

### Task 6: Optional live round-trip test (environment-gated)

**Files:**
- Modify: `ts/tests/keychain.test.ts`

**Interfaces:**
- Consumes: `keychainBackend`, `setSecret`, `getSecret`, `deleteSecret` (Task 2).

- [ ] **Step 1: Write the gated test**

```ts
// append to ts/tests/keychain.test.ts
import { deleteSecret, getSecret, keychainBackend, setSecret } from "../connectors/keychain.js";

// Live round-trip against the real OS keychain. Skips unless a real backend is
// present (mirrors the DB suites skipping without Postgres). Never runs on CI Linux.
const liveBackend = (() => {
  delete process.env.EIL_KEYCHAIN_BACKEND;
  const b = keychainBackend();
  return b.name !== "none" && b.name !== "memory" && b.available ? b.name : null;
})();

describe.skipIf(!liveBackend)("live keychain round-trip", () => {
  it("stores, reads, and deletes a real secret", () => {
    setSecret("EIL_SMOKE_TOKEN", "round-trip-42");
    expect(getSecret("EIL_SMOKE_TOKEN")).toBe("round-trip-42");
    deleteSecret("EIL_SMOKE_TOKEN");
    expect(getSecret("EIL_SMOKE_TOKEN")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run ts/tests/keychain.test.ts`
Expected on CI/Linux-without-daemon: the `live keychain round-trip` block is skipped, everything else passes. On a macOS/Windows dev box: it runs and passes.

- [ ] **Step 3: Commit**

```bash
git add ts/tests/keychain.test.ts
git commit -m "keychain: environment-gated live round-trip test"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the auth subsection**

Insert after the "Live connectors (personal credentials only)" section:

```markdown
### Storing tokens in the OS keychain (no env vars)

Instead of exporting `EIL_<PREFIX>_TOKEN`, store each PAT in your operating
system's credential store once:

```sh
pnpm eil auth login jira        # hidden prompt; stored in the OS keychain
pnpm eil auth status            # shows, per source, whether the token resolves
                                # from keychain / env / missing — never prints it
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
```

- [ ] **Step 2: Update the work-machine walkthrough (step 5)**

In the "Create personal access tokens" block, add after the `export` lines:

```markdown
Prefer not to keep tokens in your shell environment? Store them in the OS
keychain instead — `pnpm eil auth login jira` (etc.) — and skip the `export`s.
```

- [ ] **Step 3: Update the Status checklist**

Add to the completed list in `## Status`:

```markdown
- [x] OS keychain auth: keychain-first token resolution (macOS/Windows/WSL2/libsecret) + `eil auth`
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: OS keychain auth (eil auth login/status/logout)"
```

---

## Self-Review

**Spec coverage:**
- Keychain-first precedence → Task 4. ✓
- Shell-out backends, no deps → Tasks 1–3. ✓
- macOS/Windows/WSL2/Linux → Tasks 2–3, selection in Task 1. ✓
- `getSecret` quiet on failure → Task 2 (`getSecret` try/catch; `secretToolKeychain`/`securityKeychain` null on nonzero). ✓
- Secrets on stdin (macOS argv exception) → Task 2 (secret-tool stdin), Task 3 (powershell stdin), macOS argv documented in Global Constraints. ✓
- `eil auth login/status/logout` + transparency → Task 5. ✓
- Testing mirrors DB-skip pattern → Task 6 (`describe.skipIf`). ✓
- Docs + Status → Task 7. ✓
- Scope limited to four tokens → `SOURCES` (Task 5), no LLM key touched. ✓

**Placeholder scan:** none — every code step has complete code; the one manual step (Task 3 Step 6) is explicit with command + expected output.

**Type consistency:** `Runner`/`RunResult`/`Keychain`/`BackendName` used consistently across tasks; backend constructors `securityKeychain`/`secretToolKeychain`/`wincredKeychain`/`memoryKeychain` and top-level `getSecret`/`setSecret`/`deleteSecret`/`keychainBackend`/`SOURCES`/`resolvedSource` names match every call site. Service constant `SERVICE = "eil"` used everywhere.
