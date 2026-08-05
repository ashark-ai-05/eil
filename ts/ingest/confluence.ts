/**
 * Confluence normalizer. Fixture dicts and the live connector produce the
 * same page shape; this mapping is the contract either way.
 */

import { CanonicalDoc } from "../contracts/models.js";
import { extractLinks } from "./common.js";

export interface ConfluencePage {
  id: string;
  title: string;
  url?: string | null;
  author?: string | null;
  created?: string | null;
  updated?: string | null;
  ancestors?: string[];
  acl_groups?: string[];
  labels?: string[];
  body: string;
}

/**
 * Labels that retire a page. Deliberately a small, closed, literal set rather
 * than a fuzzy match: a false positive silently deletes a live document from
 * every search result, which is a far worse failure than missing a retirement.
 * Anything cleverer belongs behind an explicit source signal, not a heuristic.
 */
const RETIREMENT_LABELS = new Set(["deprecated", "archived", "obsolete", "superseded", "retired"]);

/**
 * Sentinel for "retired, but the source gave us no date to attach to it".
 *
 * Any non-null value excludes the document, which is the part that matters; the
 * timestamp is only a best-effort answer to "since when". A fixed constant keeps
 * the content hash stable across syncs — `now()` here would rewrite and re-embed
 * the page on every run.
 */
export const RETIRED_DATE_UNKNOWN = "1970-01-01T00:00:00.000Z";

/**
 * When a page stopped being true, or null if it still is.
 *
 * Dated at the page's last edit rather than at ingest time on purpose. Ingest
 * time is not a property of the source, so it would differ on every sync, change
 * the content hash every run, and re-embed the whole corpus nightly — turning a
 * validity signal into an infinite write loop.
 *
 * Fails CLOSED on a missing timestamp. Returning null for a page we know is
 * retired would silently restore it to the live corpus because the source
 * happened not to report `updated` — the retirement is the certain fact and the
 * date is the uncertain one, so uncertainty about the date must not discard the
 * fact.
 */
function retiredAt(page: ConfluencePage): string | null {
  const retired = (page.labels ?? []).some((l) =>
    RETIREMENT_LABELS.has(String(l).trim().toLowerCase()),
  );
  if (!retired) return null;
  return page.updated ?? page.created ?? RETIRED_DATE_UNKNOWN;
}

export function normalize(page: ConfluencePage, tenant = "default"): CanonicalDoc {
  const docId = `confluence:page:${page.id}`;
  return CanonicalDoc.parse({
    id: docId,
    tenant,
    source: "confluence",
    title: page.title,
    url: page.url ?? null,
    author: page.author ?? null,
    createdAt: page.created ?? null,
    updatedAt: page.updated ?? null,
    validFrom: page.created ?? page.updated ?? null,
    validTo: retiredAt(page),
    hierarchy: page.ancestors ?? [],
    aclGroups: page.acl_groups ?? [],
    qualityTier: "authored",
    body: page.labels?.length ? `**Labels:** ${page.labels.join(", ")}\n\n${page.body}` : page.body,
    links: extractLinks(page.body, docId),
  });
}
