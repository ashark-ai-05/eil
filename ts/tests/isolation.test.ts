/**
 * Parser isolation: backend boundary, the three capability states, and a real
 * end-to-end rehearsal on this host.
 *
 * The property under test throughout is that **nothing can reach a parser
 * except through a probe that actually succeeded**. Everything else here exists
 * to keep the three refusal states apart, because collapsing them is how a host
 * that silently is not enforcing a memory limit gets mistaken for a platform
 * that never supported one.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  type ExtractionIsolationBackend,
  LinuxSystemdBackend,
  type ProbeResult,
  probeIsolation,
  requireIsolation,
  resolveBackend,
} from "../isolation/index.js";
import {
  frame,
  runIsolatedForTests,
  verifyMemoryLimit,
  verifyProbeEcho,
} from "../isolation/systemd.js";

const execFileAsync = promisify(execFile);

const onLinux = process.platform === "linux";

/** A backend that is eligible but whose probe returns whatever we hand it. */
const fake = (
  name: string,
  supports: boolean,
  result?: ProbeResult,
): ExtractionIsolationBackend => ({
  name,
  supports: () => supports,
  probe: async () =>
    result ?? { ok: false, backend: name, reason: "isolation_broken", detail: "stub" },
  run: async () => {
    throw new Error("must not be called");
  },
});

describe("supports() is platform eligibility only", () => {
  it("matches the platform and nothing else", () => {
    expect(new LinuxSystemdBackend().supports()).toBe(onLinux);
  });

  it.runIf(onLinux)(
    "stays true on Linux even when systemd is entirely unreachable",
    async () => {
      // The contract that matters. If someone "improves" supports() with a
      // `which systemd-run` or a cgroup read, a Linux host one setting away
      // from working gets reported as platform_unsupported — "your OS cannot
      // do this" — and the three-state model collapses.
      const backend = new LinuxSystemdBackend();
      const realPath = process.env.PATH;
      process.env.PATH = "/nonexistent";
      try {
        expect(backend.supports()).toBe(true);
        const result = await backend.probe();
        expect(result.ok).toBe(false);
        // Prerequisites absent, NOT "this platform is unsupported".
        if (!result.ok) expect(result.reason).toBe("isolation_unavailable");
      } finally {
        process.env.PATH = realPath;
      }
    },
    30_000,
  );

  it("has a body that is the platform check and nothing else", async () => {
    // Structural, and labelled as such. The PATH test above catches a
    // `which systemd-run`, but not a check against an absolute path — and any
    // filesystem or exec call here reports a fixable Linux host as
    // `platform_unsupported`, i.e. "your OS cannot do this". Pinning the body
    // is the only way to refuse the whole category rather than one instance.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../isolation/systemd.ts", import.meta.url), "utf-8"),
    );
    const body = /supports\(\): boolean \{([\s\S]*?)\n {2}\}/.exec(src)?.[1] ?? "";
    expect(body).toContain("process.platform");
    for (const forbidden of ["require(", "access", "existsSync", "readFile", "execFile", "spawn"])
      expect(body).not.toContain(forbidden);
  });

  it("queries one unit property per call", async () => {
    // Structural, and labelled as such. `systemctl show -p A -p B --value`
    // returns properties in systemd's canonical order rather than flag order,
    // so a positional parse of a multi-property result reads the wrong value —
    // and presents exactly like an unavailable host. Nothing observable
    // distinguishes the two implementations on a healthy machine, so the
    // source is what gets pinned.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../isolation/systemd.ts", import.meta.url), "utf-8"),
    );
    const multi = /"-p",\s*\n?\s*"[A-Za-z]+",\s*\n?\s*"-p"/.test(src);
    expect(multi).toBe(false);
  });
});

describe("the three refusal states stay apart", () => {
  it("reports platform_unsupported when no backend is eligible", async () => {
    const result = await probeIsolation([fake("none", false)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("platform_unsupported");
      expect(result.backend).toBeNull();
      // Nothing to fix — offering a remedy would send an operator hunting for
      // a setting that does not exist on their OS.
      expect(result.fix).toBeUndefined();
    }
  });

  it("reports isolation_unavailable with a fix when prerequisites are absent", async () => {
    const stub: ProbeResult = {
      ok: false,
      backend: "b",
      reason: "isolation_unavailable",
      detail: "no user manager",
      fix: "enable lingering",
    };
    const result = await probeIsolation([fake("b", true, stub)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("isolation_unavailable");
      expect(result.fix).toBe("enable lingering");
    }
  });

  it("reports isolation_broken when the host looks capable and is not", async () => {
    const stub: ProbeResult = {
      ok: false,
      backend: "b",
      reason: "isolation_broken",
      detail: "memory.max is 0, expected 268435456 — the limit did not apply",
    };
    const result = await probeIsolation([fake("b", true, stub)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("isolation_broken");
  });

  it("keeps an eligible-but-misconfigured backend out of platform_unsupported", async () => {
    // resolveBackend answers eligibility, never health — otherwise a broken
    // Linux host would be indistinguishable from macOS.
    const broken = fake("b", true, {
      ok: false,
      backend: "b",
      reason: "isolation_broken",
      detail: "x",
    });
    expect(resolveBackend([broken])).toBe(broken);
  });
});

describe("nothing reaches a parser without a successful probe", () => {
  it("refuses when no backend is eligible", async () => {
    const gate = await requireIsolation([fake("none", false)]);
    expect(gate.ok).toBe(false);
    if (!gate.ok && !gate.result.ok) expect(gate.result.reason).toBe("platform_unsupported");
  });

  it("refuses when an eligible backend fails its probe", async () => {
    const gate = await requireIsolation([
      fake("b", true, { ok: false, backend: "b", reason: "isolation_broken", detail: "x" }),
    ]);
    expect(gate.ok).toBe(false);
  });

  it("hands back the backend only when the probe passed", async () => {
    const good = fake("b", true, {
      ok: true,
      backend: "b",
      detail: "verified",
      verified: { limit: true, roundTrip: true, killPath: true },
    });
    const gate = await requireIsolation([good]);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.backend).toBe(good);
  });

  it("has no runnable job in this slice, so no parser can be spawned", async () => {
    // Deliberate: the parser child arrives with pdfjs-dist, which is not
    // authorised. Until then `run()` must refuse rather than quietly exist.
    await expect(
      new LinuxSystemdBackend().run(Buffer.from("x"), {
        maxMemoryBytes: 1,
        timeoutMs: 1,
        maxOutputBytes: 1,
      }),
    ).rejects.toThrow(/no isolated job is defined/);
  });
});

describe("framing", () => {
  it("length-prefixes the body", () => {
    const f = frame(Buffer.from("hello"));
    expect(f.length).toBe(9);
    expect(f.readUInt32BE(0)).toBe(5);
    expect(f.subarray(4).toString()).toBe("hello");
  });

  it("frames an empty body without ambiguity", () => {
    const f = frame(Buffer.alloc(0));
    expect(f.length).toBe(4);
    expect(f.readUInt32BE(0)).toBe(0);
  });
});

describe("the decisions, tested directly rather than through the probe's summary", () => {
  // These exist because the first version of this file asserted the probe's own
  // evidence string. A mutation that removed a check also removed the sentence
  // claiming it, and the test passed — the decision has to be testable apart
  // from the narration.

  it("rejects an unlimited cgroup, which is the dangerous case", () => {
    // "max" means no limit. The unit started, so everything looks healthy, and
    // nothing is bounded.
    expect(verifyMemoryLimit("max", 268435456)).toMatch(/no limit was applied/);
  });

  it("rejects a limit weaker than requested", () => {
    expect(verifyMemoryLimit("999999999", 268435456)).toMatch(/weaker than the requested/);
  });

  it("rejects unusable and unreadable values", () => {
    expect(verifyMemoryLimit("0", 1000)).toMatch(/not a usable limit/);
    expect(verifyMemoryLimit("banana", 1000)).toMatch(/unreadable/);
  });

  it("accepts the exact limit and the kernel's page rounding", () => {
    expect(verifyMemoryLimit("268435456", 268435456)).toBeNull();
    // A non-page-aligned request is rounded UP by the kernel; treating that as
    // a mismatch would report a correctly-limited host as broken.
    expect(verifyMemoryLimit("8192", 5000)).toBeNull();
  });

  it("rejects a round trip that did not come back intact", () => {
    expect(verifyProbeEcho(Buffer.from('{"echo":7}'), 19)).toMatch(/reported 7 bytes/);
    expect(verifyProbeEcho(Buffer.from("not json"), 19)).toMatch(/not valid JSON/);
    expect(verifyProbeEcho(Buffer.from("{}"), 19)).toMatch(/reported undefined/);
    expect(verifyProbeEcho(Buffer.from('{"echo":19}'), 19)).toBeNull();
  });
});

describe("real host behaviour, observed rather than self-reported", () => {
  it.runIf(onLinux)(
    "fails the probe when the child lies about what it received",
    async () => {
      // Directly kills the "probe does not verify the channel" mutation: the
      // sandbox works perfectly here, and the probe must still refuse.
      const liar = [
        "node",
        "-e",
        "process.stdout.write(Buffer.from([0,0,0,10]));process.stdout.write('{\"echo\":1}')",
      ];
      const result = await new LinuxSystemdBackend().probe({ childArgv: liar });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("isolation_broken");
        expect(result.detail).toMatch(/reported 1 bytes, expected 19/);
      }
    },
    60_000,
  );

  it.runIf(onLinux)(
    "fails the probe when the child returns nothing at all",
    async () => {
      const silent = ["node", "-e", "process.exit(0)"];
      const result = await new LinuxSystemdBackend().probe({ childArgv: silent });
      expect(result.ok).toBe(false);
    },
    60_000,
  );

  it.runIf(onLinux)(
    "actually terminates a runaway child on the wall clock",
    async () => {
      // The kill path, observed end to end rather than trusted.
      const started = Date.now();
      const { outcome } = await runIsolatedForTests(
        ["node", "-e", "setInterval(()=>{},1e9)"],
        Buffer.from("x"),
        { maxMemoryBytes: 256 * 1024 * 1024, timeoutMs: 800, maxOutputBytes: 4096 },
      );
      expect(outcome.kind).toBe("timeout");
      // Bounded: a "timeout" that took a minute would mean the kill did not work.
      expect(Date.now() - started).toBeLessThan(20_000);
    },
    60_000,
  );

  it.runIf(onLinux)(
    "refuses to write the payload when the memory limit did not apply",
    async () => {
      // Tests the WIRING, not the decision: the decision has its own unit tests
      // above, but removing the `if (limitProblem) return` line left every one
      // of them passing. A host whose limit silently did not apply must never
      // receive a byte.
      const alwaysBad = () => 'memory.max is "max" — no limit was applied';
      const { outcome } = await runIsolatedForTests(
        ["node", "-e", "process.stdout.write(Buffer.from([0,0,0,2]));process.stdout.write('hi')"],
        Buffer.from("payload"),
        { maxMemoryBytes: 256 * 1024 * 1024, timeoutMs: 20_000, maxOutputBytes: 4096 },
        alwaysBad,
      );
      expect(outcome.kind).toBe("crash");
      if (outcome.kind === "crash") expect(outcome.detail).toMatch(/no limit was applied/);
    },
    60_000,
  );

  it.runIf(onLinux)(
    "attributes a memory bomb to oom, not to timeout or crash",
    async () => {
      const bomb = ["node", "-e", "const a=[];for(;;)a.push(new Uint8Array(8*1024*1024));"];
      const { outcome } = await runIsolatedForTests(bomb, Buffer.from("x"), {
        maxMemoryBytes: 128 * 1024 * 1024,
        timeoutMs: 45_000,
        maxOutputBytes: 4096,
      });
      // The attribution that a signal number alone cannot give: this and a
      // timeout are both SIGKILL.
      expect(outcome.kind).toBe("oom");
    },
    90_000,
  );
});

describe("real host rehearsal", () => {
  it.runIf(onLinux)(
    "verifies the whole path, not merely that cgroup v2 exists",
    async () => {
      const result = await new LinuxSystemdBackend().probe();
      if (!result.ok) {
        // A CI box without user systemd is a legitimate outcome; what must
        // never happen is a pass that did not exercise the channel.
        expect(["isolation_unavailable", "isolation_broken"]).toContain(result.reason);
        return;
      }
      // The probe's own evidence names each thing it proved. If any of these
      // stopped being verified the detail string would no longer say so.
      // Structured flags, each set at its check site — so removing a check
      // removes the claim, which a prose summary did not.
      expect(result.verified).toEqual({ limit: true, roundTrip: true, killPath: true });
    },
    60_000,
  );

  it.runIf(onLinux)(
    "leaves no transient units behind",
    async () => {
      // Compared against a BEFORE snapshot rather than asserting the machine is
      // globally clean. Unrelated debris from another process would otherwise
      // fail this — which it did once while I was hand-probing, and a test that
      // fails for something the code did not do is a test nobody trusts.
      const units = async (): Promise<string[]> => {
        const { stdout } = await execFileAsync("systemctl", [
          "--user",
          "list-units",
          "--all",
          "--no-legend",
          "eil-pdf-*.service",
        ]);
        return stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
      };
      const before = new Set(await units());
      await new LinuxSystemdBackend().probe();
      const added = (await units()).filter((u) => !before.has(u));
      expect(added).toEqual([]);
    },
    60_000,
  );
});
