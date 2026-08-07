/**
 * Linux systemd + cgroup v2 isolation backend.
 *
 * Every mechanism here was measured on a real host before being written down;
 * the reasoning for each choice is in `PLANS/PDF_EXTRACTION_DESIGN.md` §4/§4a.
 * The short version of the two non-obvious ones:
 *
 *  - a transient **service** with `--wait`, not a `--scope`. A scope unloads the
 *    moment its processes die, taking its cgroup — and `memory.events` — with
 *    it, so reading the OOM counter afterwards races systemd's cleanup.
 *
 *  - `RLIMIT_AS` is not used. Modern V8 reserves an enormous *virtual* range for
 *    its pointer-compression cage, so the cap must exceed ~4 GB merely for the
 *    child to boot — useless against a typed-array bomb holding gigabytes of
 *    *resident* memory inside that allowance. cgroup `MemoryMax` bounds RSS for
 *    the whole subtree, which is the quantity that matters.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  ExtractionIsolationBackend,
  IsolationLimits,
  IsolationOutcome,
  ProbeResult,
  ProbeVerified,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Unit names are generated, never derived from input, and validated anyway. */
const UNIT_NAME = /^eil-pdf-[0-9a-f]{32}\.service$/;
const READINESS_DEADLINE_MS = 5_000;
const READINESS_POLL_MS = 25;
/** Diagnostics are bounded: a child that floods stderr must not exhaust us. */
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * The probe's child. A fixed constant passed through `node -e` in an **argv
 * array** — never a shell string, and never interpolated with any value derived
 * from input. It echoes the frame's length back so the parent can verify the
 * channel end to end rather than merely observing that a process ran.
 */
const PROBE_CHILD = [
  "const c=[];",
  "process.stdin.on('data',b=>c.push(b));",
  "process.stdin.on('end',()=>{",
  "const i=Buffer.concat(c);",
  "const n=i.readUInt32BE(0);",
  "const body=i.subarray(4,4+n);",
  "const r=Buffer.from(JSON.stringify({echo:body.length}));",
  "const o=Buffer.alloc(4+r.length);",
  "o.writeUInt32BE(r.length,0);r.copy(o,4);",
  "process.stdout.write(o);",
  "});",
].join("");

export const frame = (body: Buffer): Buffer => {
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
};

/** Page size the kernel rounds cgroup limits to. */
const PAGE_BYTES = 4096;

/**
 * Is the limit the kernel actually applied acceptable for what we asked?
 *
 * Extracted as a pure function so the DECISION is directly testable. Asserting
 * it through the probe's own summary string proved worthless: a mutation that
 * removed the check also removed the sentence claiming it, and the test passed.
 *
 * Not exact equality. The kernel rounds `memory.max` up to a page, so an exact
 * `!==` would report a correctly-limited host as broken for any request that is
 * not page-aligned. What must hold is that a limit exists at all and is not
 * *weaker* than requested.
 */
export function verifyMemoryLimit(actualRaw: string, expectedBytes: number): string | null {
  const actual = actualRaw.trim();
  // "max" is cgroup for "no limit". The single most dangerous reading: the unit
  // started, so everything looks fine, and nothing is bounded.
  if (actual === "max") return 'memory.max is "max" — no limit was applied';
  const n = Number(actual);
  if (!Number.isFinite(n)) return `memory.max is unreadable (${actual})`;
  if (n <= 0) return `memory.max is ${actual} — not a usable limit`;
  const ceiling = expectedBytes + PAGE_BYTES - 1;
  if (n > ceiling) return `memory.max is ${n}, which is weaker than the requested ${expectedBytes}`;
  return null;
}

/**
 * Did the framed round trip return exactly what the child was given?
 *
 * Also pure, also for testability: this is the check that distinguishes a
 * working channel from a probe that merely watched a process start and exit.
 */
export function verifyProbeEcho(body: Buffer, expectedLength: number): string | null {
  let echoed: unknown;
  try {
    echoed = (JSON.parse(body.toString("utf-8")) as { echo?: unknown }).echo;
  } catch {
    return `response was not valid JSON (${body.subarray(0, 40).toString("utf-8")})`;
  }
  if (echoed !== expectedLength)
    return `round trip reported ${String(echoed)} bytes, expected ${expectedLength}`;
  return null;
}

const newUnitName = (): string => `eil-pdf-${randomBytes(16).toString("hex")}.service`;

/**
 * Read one unit property.
 *
 * ONE property per call, deliberately. `systemctl show -p A -p B --value`
 * returns them in systemd's canonical order rather than the order of the flags,
 * so a positional parse of a multi-property result silently reads the wrong
 * value — which presents exactly like an unavailable host.
 */
async function showProperty(unit: string, property: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "--user",
      "show",
      unit,
      "-p",
      property,
      "--value",
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Distinguishes "prerequisites absent" from "present but wrong". */
type Failure = {
  reason: "isolation_unavailable" | "isolation_broken";
  detail: string;
  fix?: string;
};

export interface Readiness {
  controlGroup: string;
  oomKillBaseline: number;
}

/** Read the cgroup's `oom_kill` counter, or null when it cannot be read. */
async function readOomKills(controlGroup: string): Promise<number | null> {
  try {
    const text = await readFile(`/sys/fs/cgroup${controlGroup}/memory.events`, "utf-8");
    const line = text.split("\n").find((l) => l.startsWith("oom_kill "));
    if (!line) return null;
    const n = Number(line.slice("oom_kill ".length).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Wait for the unit to exist and verify the limit actually applied — BEFORE any
 * hostile byte is written.
 *
 * The three outcomes are kept apart here rather than merged into a boolean:
 * a unit that never activates is a missing prerequisite, while a unit that
 * activates with the wrong `memory.max` is a host that looks capable and is not.
 */
async function awaitReadiness(
  unit: string,
  expectedMaxBytes: number,
  verifyLimit: typeof verifyMemoryLimit = verifyMemoryLimit,
): Promise<Readiness | Failure> {
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  let lastState = "(never observed)";
  while (Date.now() < deadline) {
    const state = await showProperty(unit, "ActiveState");
    if (state !== null) lastState = state;
    // Terminal, not worth waiting out. Distinguished from "not loaded yet",
    // which is a normal transient and must keep polling.
    if (state === "failed")
      return {
        reason: "isolation_broken",
        detail: `transient unit entered failed state before readiness (${unit})`,
      };
    if (state === "active") {
      const controlGroup = await showProperty(unit, "ControlGroup");
      if (!controlGroup)
        return {
          reason: "isolation_broken",
          detail: "unit is active but its ControlGroup could not be resolved",
        };
      let actual: string;
      try {
        actual = (await readFile(`/sys/fs/cgroup${controlGroup}/memory.max`, "utf-8")).trim();
      } catch (err) {
        return {
          reason: "isolation_unavailable",
          detail: `cgroup memory files are not readable: ${(err as Error).message}`,
          fix: "check that cgroup v2 is mounted and the memory controller is delegated to your user",
        };
      }
      // The check that matters. A unit that starts without its limit applied is
      // strictly worse than one that fails to start, because it looks fine.
      const limitProblem = verifyLimit(actual, expectedMaxBytes);
      if (limitProblem) return { reason: "isolation_broken", detail: limitProblem };
      const oomKillBaseline = (await readOomKills(controlGroup)) ?? 0;
      return { controlGroup, oomKillBaseline };
    }
    await sleep(READINESS_POLL_MS);
  }
  return {
    reason: "isolation_unavailable",
    detail: `unit never became active within ${READINESS_DEADLINE_MS}ms (last state: ${lastState})`,
    fix: "enable a user systemd manager and cgroup delegation (e.g. `loginctl enable-linger $USER`)",
  };
}

/** Kill the whole unit — descendants included — without needing a live child. */
async function killUnit(unit: string): Promise<void> {
  try {
    await execFileAsync("systemctl", [
      "--user",
      "kill",
      "--kill-whom=all",
      "--signal=SIGKILL",
      unit,
    ]);
  } catch {
    /* already gone; the reap below is what actually matters */
  }
}

/**
 * Clean up the transient unit.
 *
 * `reset-failed` ONLY when the unit is in `failed`. A cleanly exited transient
 * unit unloads itself, and `reset-failed` then reports "Unit not loaded" — the
 * normal path, not an error to log.
 */
async function cleanupUnit(unit: string): Promise<void> {
  if ((await showProperty(unit, "ActiveState")) !== "failed") return;
  try {
    await execFileAsync("systemctl", ["--user", "reset-failed", unit]);
  } catch {
    /* best effort; a stale transient unit is not worth failing a run over */
  }
}

/** Collect a length-prefixed response, refusing an oversized frame early. */
function collectFrame(
  child: ChildProcess,
  maxOutputBytes: number,
): { body: () => Buffer | null; overflow: () => boolean } {
  const chunks: Buffer[] = [];
  let total = 0;
  let overflowed = false;
  child.stdout?.on("data", (b: Buffer) => {
    if (overflowed) return;
    chunks.push(b);
    total += b.length;
    // Declared size is checked as soon as the prefix arrives, so an oversized
    // frame is refused BEFORE its body is buffered.
    if (total >= 4) {
      const declared = Buffer.concat(chunks).readUInt32BE(0);
      if (declared > maxOutputBytes || total > maxOutputBytes + 4) {
        overflowed = true;
        child.kill("SIGKILL");
      }
    }
  });
  return {
    overflow: () => overflowed,
    body: () => {
      if (overflowed) return null;
      const all = Buffer.concat(chunks);
      if (all.length < 4) return null;
      const declared = all.readUInt32BE(0);
      // A frame shorter than it declares is a partial frame, not a short answer.
      if (all.length < 4 + declared) return null;
      return all.subarray(4, 4 + declared);
    },
  };
}

interface RunRaw {
  outcome: IsolationOutcome;
}

/** One isolated execution: launch, verify, write, read, classify, clean up. */
async function runIsolated(
  argv: string[],
  input: Buffer,
  limits: IsolationLimits,
  verifyLimit: typeof verifyMemoryLimit = verifyMemoryLimit,
): Promise<RunRaw> {
  const unit = newUnitName();
  /* c8 ignore next */
  if (!UNIT_NAME.test(unit)) throw new Error("generated unit name failed validation");

  const child = spawn(
    "systemd-run",
    [
      "--user",
      "--pipe",
      "--wait",
      "-q",
      `--unit=${unit}`,
      "-p",
      `MemoryMax=${limits.maxMemoryBytes}`,
      // Without this the cgroup swaps instead of being killed, and a memory
      // bomb thrashes rather than terminating. Measured.
      "-p",
      "MemorySwapMax=0",
      "--",
      ...argv,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr?.on("data", (b: Buffer) => {
    if (stderr.length < MAX_STDERR_BYTES) stderr += b.toString("utf-8");
  });
  const collector = collectFrame(child, limits.maxOutputBytes);

  const spawnFailed = new Promise<Error | null>((resolve) => {
    child.once("error", (e) => resolve(e));
    child.once("spawn", () => resolve(null));
  });
  const spawnErr = await spawnFailed;
  if (spawnErr)
    return {
      outcome: {
        kind: "attribution_unavailable",
        detail: `systemd-run could not be launched: ${spawnErr.message}`,
      },
    };

  const ready = await awaitReadiness(unit, limits.maxMemoryBytes, verifyLimit);
  if ("reason" in ready) {
    // Never wrote a byte. Kill and reap the forwarder so nothing is orphaned.
    await killUnit(unit);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("close", r));
    await cleanupUnit(unit);
    return { outcome: { kind: "crash", detail: `${ready.reason}: ${ready.detail}` } };
  }

  // Only now is the payload written.
  child.stdin?.end(frame(input));

  let weKilled = false;
  const timer = setTimeout(() => {
    weKilled = true;
    void killUnit(unit);
  }, limits.timeoutMs);

  const exitCode = await new Promise<number | null>((r) => child.once("close", (c) => r(c)));
  clearTimeout(timer);

  const result = await showProperty(unit, "Result");
  const oomNow = await readOomKills(ready.controlGroup);
  await cleanupUnit(unit);

  // Attribution, in priority order. The parent knows whether IT sent the kill;
  // that beats any signal, because a timeout kill and an OOM kill are both
  // SIGKILL and indistinguishable from the exit status alone.
  if (weKilled) return { outcome: { kind: "timeout" } };
  if (result === "oom-kill" || (oomNow !== null && oomNow > ready.oomKillBaseline))
    return { outcome: { kind: "oom" } };
  if (collector.overflow())
    return { outcome: { kind: "crash", detail: "response frame exceeded the output ceiling" } };

  const body = collector.body();
  if (body === null) {
    if (result === null)
      return {
        outcome: {
          kind: "attribution_unavailable",
          detail: `no response frame and the unit's Result could not be read (exit ${exitCode})`,
        },
      };
    return {
      outcome: {
        kind: "crash",
        detail:
          `no complete response frame (exit ${exitCode}, Result=${result}) ${stderr.trim()}`.trim(),
      },
    };
  }
  return { outcome: { kind: "ok", body } };
}

export { runIsolated as runIsolatedForTests };

export class LinuxSystemdBackend implements ExtractionIsolationBackend {
  readonly name = "linux-systemd";

  /** Platform eligibility ONLY — see the interface docs for why. */
  supports(): boolean {
    return process.platform === "linux";
  }

  /**
   * Rehearse the entire path, not merely detect cgroup v2.
   *
   * Detection alone passes on a host where user delegation is off, or where
   * stdio forwarding does not work — and then every real run fails. The probe
   * therefore sends a real payload and verifies the exact response, then proves
   * the kill path, then cleans up.
   */
  async probe(opts: { childArgv?: string[] } = {}): Promise<ProbeResult> {
    const payload = Buffer.from("eil isolation probe");
    const limits: IsolationLimits = {
      maxMemoryBytes: 256 * 1024 * 1024,
      timeoutMs: 20_000,
      maxOutputBytes: 4096,
    };

    const childArgv = opts.childArgv ?? ["node", "-e", PROBE_CHILD];
    const { outcome } = await runIsolated(childArgv, payload, limits);
    if (outcome.kind !== "ok") {
      const detail = "detail" in outcome ? outcome.detail : outcome.kind;
      // A missing binary or an inactive user manager is a prerequisite problem;
      // anything else got far enough that the host looked capable.
      const unavailable = /ENOENT|could not be launched|never became active|not readable/.test(
        detail,
      );
      return {
        ok: false,
        backend: this.name,
        reason: unavailable ? "isolation_unavailable" : "isolation_broken",
        detail,
        ...(unavailable
          ? { fix: "install systemd, enable a user manager and cgroup delegation" }
          : {}),
      };
    }

    const echoProblem = verifyProbeEcho(outcome.body, payload.length);
    if (echoProblem)
      return { ok: false, backend: this.name, reason: "isolation_broken", detail: echoProblem };
    // Set where the check passes, never assembled at the end.
    const verified: ProbeVerified = { limit: true, roundTrip: true, killPath: false };

    // The kill path is proved separately: a probe that only ever runs a job
    // that finishes says nothing about whether a runaway one can be stopped.
    const killed = await runIsolated(["node", "-e", "setInterval(()=>{},1e9)"], payload, {
      ...limits,
      timeoutMs: 750,
    });
    verified.killPath = killed.outcome.kind === "timeout";
    if (!verified.killPath)
      return {
        ok: false,
        backend: this.name,
        reason: "isolation_broken",
        detail: `timeout kill did not terminate a runaway child (got ${killed.outcome.kind})`,
      };

    return {
      ok: true,
      backend: this.name,
      verified,
      detail:
        `transient unit created, MemoryMax verified at ${limits.maxMemoryBytes} bytes, ` +
        `${payload.length}-byte framed round trip verified, timeout kill and cleanup verified`,
    };
  }

  async run(input: Buffer, limits: IsolationLimits): Promise<IsolationOutcome> {
    // Placeholder for the extraction slice: this backend currently has exactly
    // one job shape, the probe child. The parser child arrives with pdfjs-dist,
    // which is not authorised yet — so refusing here is deliberate, and keeps
    // this slice free of any path that could spawn a parser.
    void input;
    void limits;
    throw new Error("no isolated job is defined until the PDF extraction slice lands");
  }
}
