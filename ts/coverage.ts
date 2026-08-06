/**
 * Coverage honesty: what the corpus behind this answer actually covers.
 *
 * The freshness bounds say how old the cited evidence is. They say nothing about
 * evidence that was never fetched. An answer drawn from a corpus whose Jira
 * connector died last Tuesday is identical, field for field, to the same answer
 * drawn from a healthy one: same citations, same verification, and a
 * `corpus_current_to` computed from the sources that DID sync.
 *
 * That is the same defect as `evidence_verified`, one level up. There, the
 * absence of a check read as a passed check. Here, the absence of a SOURCE reads
 * as the absence of evidence — so "nothing matched" and "that system has not
 * answered since Tuesday" arrive in the caller's context window wearing the same
 * shape. The first invites a conclusion; the second forbids one.
 *
 * Everything here is scoped to the viewer's tenant and, for the quarantine
 * count, to what the viewer could otherwise read. A disclosure that widens what
 * a caller can learn is not a safety feature.
 */

import type { Db } from "./db.js";

/**
 * The sync SLA: hours after which a source is reported stale, and therefore no
 * longer able to support a claim that nothing is missing.
 *
 * Defaults to the 24h threshold `integrity()` already applies to
 * `stale_sources`, so the operator report and the per-answer disclosure cannot
 * describe the same corpus differently — two definitions of "stale" is how a
 * dashboard ends up disagreeing with the tool everyone actually reads.
 *
 * Configurable because staleness is a statement about a deployment's ingest
 * cadence, not a universal constant: a corpus that syncs weekly by design is not
 * misreporting itself, it has a different SLA. Making it settable is the correct
 * answer to "every real deployment would read incomplete" — the alternative,
 * declaring stale data complete, makes the word mean nothing instead.
 */
export const staleAfterHours = (): number => {
  const raw = Number(process.env.EIL_COVERAGE_SLA_HOURS);
  // Fails to the default on anything unparseable rather than to Infinity: a
  // typo in an env var must not silently switch off the disclosure.
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
};

/**
 * Worst-first. A family aggregates to its sickest scope, for the same reason
 * `corpusCurrentTo` takes `min()`: one freshly-synced space must not vouch for
 * the twelve beside it that have not run since March.
 */
const STATE_RANK = ["never_synced", "failing", "stale", "current"] as const;
export type SourceState = (typeof STATE_RANK)[number];

export interface SourceCoverage {
  /** Source family — `confluence`, `jira`, `code`. Scoped cursors such as
   *  `confluence:space:ENG` aggregate into their family. */
  source: string;
  state: SourceState;
  /** Null when nothing has ever landed. Null is reported, never omitted. */
  last_success_at: string | null;
  /** Failed RUNS in a row. Says nothing about documents lost inside a good run. */
  consecutive_failures: number;
  /**
   * Documents that failed to land during this source's LAST run.
   *
   * The gap `consecutive_failures` cannot express: a run that listed 4,000 files,
   * could not read 3, and completed normally. That run records a fresh
   * `last_success_at` and zero consecutive failures while three documents are
   * simply absent from the corpus — and absence is indistinguishable from
   * "nothing to find" at query time.
   *
   * Counts genuine failures only. Files excluded by path or content policy are
   * not failures; every repository skips vendored trees and binaries, and
   * folding those in would report every corpus as permanently broken.
   */
  item_failures: number;
}

export interface Coverage {
  /**
   * Whether this answer rests on a corpus with nothing known to be missing.
   *
   * False on: a requested source with no connector at all, any source not in
   * `current` state, any document that failed to land in a source's last run,
   * or evidence quarantined out of the viewer's reach.
   *
   * `stale` clears it too. Whether a corpus past its SLA is merely "behind" or
   * genuinely missing something depends on whether the source changed in the
   * meantime, which the catalog cannot know — and `complete` is a positive
   * claim, so unknown must not read as true. A deployment with a slower ingest
   * cadence raises EIL_COVERAGE_SLA_HOURS rather than being told its stale data
   * is complete.
   */
  complete: boolean;
  sources: SourceCoverage[];
  /**
   * Sources the caller explicitly asked for that have no connector in this
   * tenant — never configured, or configured and never run.
   *
   * This is the difference between "I searched Jira and found nothing" and "you
   * asked for Jira and there is no Jira here". Without it the second silently
   * renders as the first, which is the one failure a scoped search must never
   * commit: the caller narrowed the scope precisely because that source mattered.
   */
  requested_absent: string[];
  /**
   * Documents withheld from this answer because secret-scanning quarantined them.
   *
   * Counted against what this viewer could OTHERWISE read, not against the
   * tenant. A tenant-wide count would tell every viewer how many documents exist
   * that they have no right to know about — disclosure is supposed to narrow the
   * gap between what the answer claims and what the corpus holds, not widen what
   * the caller can infer.
   */
  quarantined_docs: number;
}

/** Cursor sources are scoped (`code:org/repo`); callers name families (`code`). */
const family = (source: string): string => source.split(":")[0] ?? source;

const worst = (a: SourceState, b: SourceState): SourceState =>
  STATE_RANK.indexOf(a) <= STATE_RANK.indexOf(b) ? a : b;

/**
 * A cursor row's state.
 *
 * Order is load-bearing. `never_synced` is checked first because a row can carry
 * `consecutive_failures = 0` while having never once succeeded — a cursor
 * written by a run that has not yet landed a document. Reading that as `current`
 * would let a connector that has never worked report a healthy corpus, which is
 * precisely the no-data-reads-as-OK shape this module exists to close.
 *
 * `failing` outranks `stale` because a source that succeeded an hour ago and has
 * failed every run since is not fresh — it is broken, and its recency is the
 * misleading part.
 */
function stateOf(row: {
  last_success_at: unknown;
  consecutive_failures: unknown;
  age_hours: unknown;
}): SourceState {
  if (row.last_success_at == null) return "never_synced";
  if (Number(row.consecutive_failures ?? 0) > 0) return "failing";
  const age = row.age_hours == null ? null : Number(row.age_hours);
  if (age == null || !Number.isFinite(age)) return "stale";
  return age > staleAfterHours() ? "stale" : "current";
}

export interface CoverageScope {
  tenant: string;
  principal: string;
  groups: string[];
}

/**
 * The coverage basis for one answer.
 *
 * `requested` is the caller's source filter — `null` means "no filter", which
 * cannot produce an absent source because nothing specific was asked for.
 */
export async function coverageFor(
  client: Db,
  scope: CoverageScope,
  requested: readonly string[] | null,
  includeSuperseded = false,
): Promise<Coverage> {
  // Null means "no filter", so every connector in the tenant is part of the
  // basis. A non-null filter names exactly the sources this answer consulted.
  const wanted = requested === null ? null : new Set(requested.map((s) => family(String(s))));

  // The existing health view, not a second definition of the same question. It
  // already splits `updated_at` (we wrote the row) from `last_success_at` (a
  // document actually landed), which is the distinction the whole disclosure
  // rests on — see migration 0018.
  const health = await client.query(
    "SELECT source, last_success_at, consecutive_failures, last_run_item_failures, age_hours" +
      " FROM metrics.vw_connector_health WHERE tenant = $1",
    [scope.tenant],
  );

  // `last_error` is deliberately not selected. It is free text from the source
  // system and routinely carries hostnames, internal URLs and occasionally a
  // credential in a query string. A viewer needs to know a source is failing;
  // the reason is an operator question, and `eil doctor` is where it is answered.
  const byFamily = new Map<string, SourceCoverage>();
  for (const row of health.rows) {
    const key = family(String(row.source));
    // Health is scoped to the sources this answer could have drawn from. An
    // unrelated dead Jira connector says nothing about a code-only answer, and
    // letting it clear `complete` there would train callers to ignore the flag
    // on precisely the answers where it matters.
    if (wanted !== null && !wanted.has(key)) continue;
    const state = stateOf(row);
    const lastSuccess = row.last_success_at ? new Date(row.last_success_at).toISOString() : null;
    const failures = Number(row.consecutive_failures ?? 0);
    const itemFailures = Number(row.last_run_item_failures ?? 0);
    const seen = byFamily.get(key);
    if (!seen) {
      byFamily.set(key, {
        source: key,
        state,
        last_success_at: lastSuccess,
        consecutive_failures: failures,
        item_failures: itemFailures,
      });
      continue;
    }
    seen.state = worst(seen.state, state);
    // Oldest success across the family, matching the state aggregation: the
    // family's freshness claim is its weakest scope's, not its strongest.
    if (
      seen.last_success_at !== null &&
      (lastSuccess === null || lastSuccess < seen.last_success_at)
    )
      seen.last_success_at = lastSuccess;
    seen.consecutive_failures = Math.max(seen.consecutive_failures, failures);
    // Summed, not maxed: two scopes of one family each losing three documents
    // have lost six, and a family's report is about how much of it is missing.
    seen.item_failures += itemFailures;
  }

  const sources = [...byFamily.values()].sort((a, b) => a.source.localeCompare(b.source));
  const requestedAbsent = (requested ?? [])
    .map((s) => family(String(s)))
    .filter((s, i, all) => all.indexOf(s) === i && !byFamily.has(s))
    .sort();

  // Scoped three ways on purpose: to the tenant, to what this viewer could
  // otherwise read, and to the sources actually searched. A quarantined Jira
  // page is not something withheld from a search restricted to the wiki, and
  // counting it there would report a gap that does not exist in this answer.
  const params: unknown[] = [scope.tenant, scope.principal, scope.groups];
  let sql =
    "SELECT count(*)::int AS n FROM documents d" +
    " WHERE d.tenant = $1 AND d.quarantined_at IS NOT NULL AND d.tombstoned_at IS NULL" +
    " AND (d.ingested_by = $2 OR d.acl_groups ?| $3::text[])";
  if (!includeSuperseded) sql += " AND d.valid_to IS NULL";
  if (requested !== null) {
    params.push([...requested]);
    sql += ` AND d.source = ANY($${params.length}::text[])`;
  }
  const quarantined = Number((await client.query(sql, params)).rows[0]?.n ?? 0);

  // Any state other than `current` means the catalog cannot assert that nothing
  // is missing. An earlier version blessed `stale` as complete on the reasoning
  // that a corpus synced 25 hours ago is "behind, not incomplete" — but which of
  // those it is depends on whether the SOURCE changed in the meantime, and the
  // catalog has no way to know that. Past the declared SLA the honest answer is
  // that completeness is unknown, and `complete` is a positive claim.
  //
  // The concern that motivated the old behaviour — that a slow-cadence
  // deployment sits permanently at `complete: false` — is answered by
  // EIL_COVERAGE_SLA_HOURS, not by weakening the word.
  const unhealthy = sources.some((s) => s.state !== "current");
  const itemFailures = sources.reduce((n, s) => n + s.item_failures, 0);
  return {
    // An empty `sources` list means no connector has ever written a cursor in
    // this tenant, so nothing here is known to be covered by anything. Reporting
    // that as complete would bless a corpus that was hand-loaded or is simply
    // empty, which is the most optimistic possible reading of no data.
    complete:
      sources.length > 0 &&
      !unhealthy &&
      itemFailures === 0 &&
      requestedAbsent.length === 0 &&
      quarantined === 0,
    sources,
    requested_absent: requestedAbsent,
    quarantined_docs: quarantined,
  };
}
