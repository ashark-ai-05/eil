/**
 * The isolation boundary: one way to run a hostile parser under an enforceable
 * resource limit.
 *
 * This exists as an interface rather than inline orchestration because the
 * mechanism is platform-specific and the caller must not learn it. `Result=oom-kill`,
 * `memory.events`, `systemctl kill --kill-whom=all` and `--pipe` framing are
 * systemd facts; if any of them reach extraction code, a second backend cannot
 * be added without rewriting the caller.
 *
 * So `run()` returns an ALREADY-CLASSIFIED outcome. Nothing above this layer
 * inspects a signal number or a unit property.
 */

/**
 * Why isolation is not usable here. Three states, because they need three
 * different responses and collapsing them misdirects the operator.
 *
 * `platform_unsupported` — no backend exists for this OS. Nothing to fix.
 * `isolation_unavailable` — a backend applies but its prerequisites are absent.
 *                           Fixable: enable user lingering, cgroup delegation.
 * `isolation_broken`      — prerequisites LOOK present and the probe still
 *                           failed. The host appears capable and is not, which
 *                           is why this is the loudest of the three: a limit
 *                           that silently does not apply reads as a platform
 *                           limitation rather than the misconfiguration it is.
 */
export type IsolationUnavailableReason =
  | "platform_unsupported"
  | "isolation_unavailable"
  | "isolation_broken";

/**
 * What the probe actually proved, one flag per check.
 *
 * Structured rather than a prose summary because a hand-written sentence is not
 * evidence: a mutation that removed a check left the sentence claiming it, and
 * every test still passed. Each flag is set at the check site, so deleting the
 * check deletes the claim.
 */
export interface ProbeVerified {
  /** The cgroup memory limit was read back and is no weaker than requested. */
  limit: boolean;
  /** A framed payload went in and came back intact. */
  roundTrip: boolean;
  /** A runaway child was actually terminated on the wall clock. */
  killPath: boolean;
}

export interface ProbeOk {
  ok: true;
  backend: string;
  /** Human-readable evidence, for the operator. */
  detail: string;
  verified: ProbeVerified;
}

export interface ProbeFailure {
  ok: false;
  backend: string | null;
  reason: IsolationUnavailableReason;
  detail: string;
  /** What the operator could change. Absent when nothing can be. */
  fix?: string;
}

export type ProbeResult = ProbeOk | ProbeFailure;

/** Limits applied to one isolated run. */
export interface IsolationLimits {
  /** Resident memory ceiling for the child AND its descendants. */
  maxMemoryBytes: number;
  /** Wall clock, enforced by the parent and not dependent on a responsive child. */
  timeoutMs: number;
  /** Ceiling on the framed response, checked before the body is buffered. */
  maxOutputBytes: number;
}

/**
 * What happened to one isolated run.
 *
 * `timeout` / `oom` / `crash` are distinguished by the backend from authoritative
 * sources, never inferred from a signal — a timeout kill and an OOM kill are
 * both SIGKILL.
 *
 * `attribution_unavailable` is deliberately its own outcome rather than a guess:
 * if the unit vanished or its counters could not be read, the run failed and we
 * do not know why. Claiming `oom` without evidence would misdirect capacity
 * planning.
 */
export type IsolationOutcome =
  | { kind: "ok"; body: Buffer }
  | { kind: "timeout" }
  | { kind: "oom" }
  | { kind: "crash"; detail: string }
  | { kind: "attribution_unavailable"; detail: string };

export interface ExtractionIsolationBackend {
  readonly name: string;

  /**
   * Platform eligibility ONLY.
   *
   * Reads `process.platform` and nothing else — no filesystem access, no
   * `which systemd-run`, no cgroup read. Every one of those is a CONFIGURATION
   * fact, and admitting one here would report a Linux host that is one setting
   * away from working as `platform_unsupported`: "your OS cannot do this", when
   * the truth is "your host needs a setting". That collapses the three-state
   * model this module exists to keep apart.
   */
  supports(): boolean;

  /** Full rehearsal of the real path. Expensive; run once per session. */
  probe(): Promise<ProbeResult>;

  /** Run one isolated job. Called ONLY after probe() succeeded. */
  run(input: Buffer, limits: IsolationLimits): Promise<IsolationOutcome>;
}
