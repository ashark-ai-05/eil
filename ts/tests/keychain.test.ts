import { afterEach, describe, expect, it } from "vitest";
import {
  detectWsl,
  getSecret,
  memoryKeychain,
  secretToolKeychain,
  securityKeychain,
  selectBackend,
  setSecret,
  wincredKeychain,
} from "../connectors/keychain.js";

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
    expect(
      detectWsl(() => {
        throw new Error("no file");
      }),
    ).toBe(false);
  });
});

function recorder() {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
  const runner = (cmd: string, args: string[], input?: string) => {
    calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) });
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
    expect(calls[0]?.args).toEqual([
      "add-generic-password",
      "-a",
      "EIL_JIRA_TOKEN",
      "-s",
      "eil",
      "-U",
      "-w",
      "pat-1",
    ]);
    expect(calls[1]?.args).toEqual([
      "find-generic-password",
      "-a",
      "EIL_JIRA_TOKEN",
      "-s",
      "eil",
      "-w",
    ]);
    expect(calls[2]?.args).toEqual([
      "delete-generic-password",
      "-a",
      "EIL_JIRA_TOKEN",
      "-s",
      "eil",
    ]);
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
    expect(calls[0]?.args).toEqual([
      "store",
      "--label=eil EIL_JIRA_TOKEN",
      "service",
      "eil",
      "account",
      "EIL_JIRA_TOKEN",
    ]);
    expect(calls[0]?.input).toBe("pat-1");
    expect(calls[0]?.args).not.toContain("pat-1");
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

describe("Windows/WSL wincred backend", () => {
  it("invokes powershell.exe with an EncodedCommand and secret on stdin", () => {
    const { calls, runner } = recorder();
    const kc = wincredKeychain(runner);
    kc.set("EIL_JIRA_TOKEN", "pat-1");
    expect(calls[0]!.cmd).toBe("powershell.exe");
    expect(calls[0]!.args.slice(0, 3)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    // secret travels on stdin, never argv
    expect(calls[0]!.input).toBe("pat-1");
    expect(calls[0]!.args.join(" ")).not.toContain("pat-1");
    // the encoded script targets eil:EIL_JIRA_TOKEN
    const script = Buffer.from(calls[0]!.args[3]!, "base64").toString("utf16le");
    expect(script).toContain("eil:EIL_JIRA_TOKEN");
    expect(script).toContain("CredWrite");
  });

  it("get returns null when CredRead exits nonzero", () => {
    const kc = wincredKeychain(() => ({ status: 1, stdout: "" }));
    expect(kc.get("EIL_JIRA_TOKEN")).toBeNull();
  });

  it("rejects an account name that could break out of the script literal", () => {
    const kc = wincredKeychain(() => ({ status: 0, stdout: "" }));
    expect(() => kc.set('EIL_JIRA_TOKEN"; calc; #', "x")).toThrow(/invalid keychain account/);
  });
});
