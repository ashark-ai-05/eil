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
