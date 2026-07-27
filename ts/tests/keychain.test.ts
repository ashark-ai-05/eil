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
    expect(
      detectWsl(() => {
        throw new Error("no file");
      }),
    ).toBe(false);
  });
});
