/**
 * The gate. Every check is a small pure function over the typed body, with an
 * enumerated id and a severity, so a refusal names itself. The analyser imports
 * `scoring` and `assemble` rather than re-deriving anything, so scorer and
 * checker cannot disagree.
 *
 * `mode: "exit"` is the gate — any error-severity finding blocks emission.
 * `mode: "lint"` downgrades ONLY the GATE family, for mid-loop use.
 */
import { assemble } from "./assemble.js";
import { SCORING_CHECKS } from "./checks/scoring.js";
import { STRUCTURAL_CHECKS, schemaIssueFindings } from "./checks/structural.js";
import type { Finding, ReqsBody } from "./schema.js";
import { parseReqs } from "./schema.js";

export interface CheckContext {
  body: ReqsBody;
  /** the same body with every generated field recomputed */
  assembled: ReqsBody;
  /** injected, so the analyser is unit-testable with no database */
  resolveDoc?: (docId: string) => Promise<string | null>;
}

export interface Check {
  id: string;
  severity: "error" | "warning";
  run(ctx: CheckContext): Finding[] | Promise<Finding[]>;
}

export interface AnalyseResult {
  findings: Finding[];
  checksRun: number;
  ok: boolean;
}

export function allChecks(): Check[] {
  return [...STRUCTURAL_CHECKS, ...SCORING_CHECKS];
}

export async function analyse(
  raw: unknown,
  opts: { mode?: "exit" | "lint"; resolveDoc?: (docId: string) => Promise<string | null> } = {},
): Promise<AnalyseResult> {
  const mode = opts.mode ?? "exit";
  const parsed = parseReqs(raw);
  if (!parsed.ok) {
    // Nothing downstream can be trusted to have the right shape, so the run
    // stops here. The message formatter is shared with the SCHEMA-001 check so
    // the two entry points cannot word the same refusal differently.
    return { findings: schemaIssueFindings(parsed.issues), checksRun: 1, ok: false };
  }

  const ctx: CheckContext = {
    body: parsed.body,
    assembled: assemble(parsed.body),
    // assigned only when supplied: under exactOptionalPropertyTypes an explicit
    // `undefined` is not the same thing as an absent key.
    ...(opts.resolveDoc ? { resolveDoc: opts.resolveDoc } : {}),
  };

  // A check that needs a resolver it has not been given is SKIPPED, not passed:
  // it drops out of `checksRun` so the count itself records the omission.
  const checks = allChecks().filter((c) => c.id !== "CLARIFY-005" || ctx.resolveDoc);
  const findings: Finding[] = [];
  for (const c of checks) findings.push(...(await c.run(ctx)));

  const effective =
    mode === "lint"
      ? findings.map((f) => (f.id.startsWith("GATE-") ? { ...f, severity: "warning" as const } : f))
      : findings;

  return {
    findings: effective,
    checksRun: checks.length,
    ok: !effective.some((f) => f.severity === "error"),
  };
}
