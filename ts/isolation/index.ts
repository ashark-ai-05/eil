/**
 * Backend resolution and the shared capability surface.
 *
 * One place answers "can this host isolate a parser, and if not, why" — so
 * `eil doctor`, coverage reporting and (later) the extraction command all give
 * the operator the same answer for the same reason.
 */

import { LinuxSystemdBackend } from "./systemd.js";
import type { ExtractionIsolationBackend, ProbeResult } from "./types.js";

export type {
  ExtractionIsolationBackend,
  IsolationLimits,
  IsolationOutcome,
  IsolationUnavailableReason,
  ProbeResult,
  ProbeVerified,
} from "./types.js";
export { LinuxSystemdBackend } from "./systemd.js";

/** Registered backends, in preference order. Adding macOS or Windows is additive. */
export const BACKENDS: ExtractionIsolationBackend[] = [new LinuxSystemdBackend()];

/**
 * The first backend eligible for this platform, or null.
 *
 * Eligibility is `supports()` — platform only. A backend that applies but whose
 * host is misconfigured is still returned here, because that distinction is
 * `probe()`'s to make: reporting it as "no backend" would tell a Linux operator
 * their OS cannot do this when a single setting would fix it.
 */
export function resolveBackend(
  backends: ExtractionIsolationBackend[] = BACKENDS,
): ExtractionIsolationBackend | null {
  return backends.find((b) => b.supports()) ?? null;
}

/**
 * Resolve and rehearse in one call — the entry point for every caller.
 *
 * Returns a `ProbeResult` whose failure reason is exactly one of the three
 * states, so no caller has to derive it.
 */
export async function probeIsolation(
  backends: ExtractionIsolationBackend[] = BACKENDS,
): Promise<ProbeResult> {
  const backend = resolveBackend(backends);
  if (!backend)
    return {
      ok: false,
      backend: null,
      reason: "platform_unsupported",
      detail: `no isolation backend exists for ${process.platform}; sandboxed extraction runs on Linux only in this release`,
    };
  return backend.probe();
}

/**
 * Guard for anything that would run a parser.
 *
 * Returns the backend when the host is verified, and otherwise the reason —
 * so the only way to reach a parser is through a successful probe. A caller
 * that ignores the failure branch has to do so visibly.
 */
export async function requireIsolation(
  backends: ExtractionIsolationBackend[] = BACKENDS,
): Promise<{ ok: true; backend: ExtractionIsolationBackend } | { ok: false; result: ProbeResult }> {
  const result = await probeIsolation(backends);
  if (!result.ok) return { ok: false, result };
  const backend = resolveBackend(backends);
  /* c8 ignore next */
  if (!backend) return { ok: false, result };
  return { ok: true, backend };
}
