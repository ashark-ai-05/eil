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
