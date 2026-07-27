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
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string t, UInt32 ty, UInt32 f);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
}
"@`;

/** account is validated to [A-Z0-9_] before reaching here (guard enforces it), so it is safe to
 *  interpolate into the PowerShell string literal for the target name. */
function psScript(op: "get" | "set" | "delete", account: string): string {
  if (!/^[A-Z0-9_]+$/.test(account)) {
    throw new Error(`invalid keychain account name: ${account}`);
  }
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
    available: () =>
      run("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"])
        .status === 0,
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

export function keychain(runner: Runner = defaultRunner): Keychain {
  switch (selectBackend()) {
    case "security":
      return securityKeychain(runner);
    case "secret-tool":
      return secretToolKeychain(runner);
    case "wincred":
      return wincredKeychain(runner);
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
