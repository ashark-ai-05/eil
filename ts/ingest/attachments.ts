/**
 * Confluence and Jira attachment acquisition.
 *
 * Bytes only. Nothing here extracts, parses or serves an attachment — this
 * makes the original file durable so a later extractor can be re-run without
 * going back to the source.
 *
 * The shape follows the runner contract added alongside it: acquisition happens
 * BEFORE any transaction, and its failures become health debt that marks the run
 * unhealthy without pinning the cursor. A too-large attachment can never
 * succeed, so holding the watermark on it would re-fetch the same window
 * forever. Persistence then happens inside the parent document's single
 * transaction via `persistRelated`.
 *
 * The organising distinction, and the source of every subtle bug in this file,
 * is that THREE different things look like "no attachment":
 *
 *   1. the source listed none               -> retire what we still hold
 *   2. the source listed one we cannot use  -> keep it, and take debt
 *   3. we could not read the listing at all -> retire NOTHING
 *
 * Collapsing any pair of those deletes evidence. So identity (what the source
 * says exists) is tracked separately from usability (what we can fetch), and
 * completeness is tracked separately from both.
 */

import { artifactMaxBytes, publishArtifactVersion, retireArtifactVersion } from "../artifacts.js";
import { getBytes } from "../connectors/auth.js";
import type { DcClient } from "../connectors/auth.js";
import { ResponseTooLarge } from "../connectors/httperror.js";
import type { Tx } from "../db.js";

/** Bounds on metadata copied verbatim from an upstream system. */
const MAX_FILENAME = 255;
const MAX_MEDIA_TYPE = 128;
const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/**
 * Identity fields are validated by PATTERN, not repaired.
 *
 * A native id and a revision are reconciliation keys: they decide what is
 * retired. Stripping a bad character out of one produces a DIFFERENT key that
 * silently fails to match what is stored, so the attachment reads as vanished
 * and its evidence is deleted. Anything that would need repairing is refused.
 */
const NATIVE_ID = /^[A-Za-z0-9._:~-]{1,128}$/;
const REVISION = /^[A-Za-z0-9._-]{1,64}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A metadata field that was present but unusable, as distinct from absent. */
const INVALID = Symbol("invalid-metadata");
type Checked = string | null | typeof INVALID;

/**
 * Validate an optional free-text field.
 *
 * Absent is fine and yields null. Present-but-unusable yields INVALID, which
 * the caller turns into refusal debt. Note what is NOT here: truncation. An
 * over-long filename silently cut to 255 characters is a value the source never
 * had, recorded as though it did.
 */
export function checkedText(v: unknown, max: number): Checked {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return INVALID;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (CONTROL.test(trimmed)) return INVALID;
  if (trimmed.length > max) return INVALID;
  return trimmed;
}

export interface AttachmentRef {
  nativeId: string;
  revision: string;
  mediaType: string;
  filename: string | null;
  /** Path relative to the connector base URL. Never an absolute URL. */
  downloadPath: string;
}

export interface AttachmentListing {
  /** Attachments we can actually fetch. A SUBSET of `listedNativeIds`. */
  refs: AttachmentRef[];
  /**
   * Every native id the source validly named, whether or not it is fetchable.
   *
   * Reconciliation reads THIS. An attachment whose download link is off-origin
   * is still on the page; deriving presence from `refs` would retire every
   * stored revision of it because we declined to follow its link.
   */
  listedNativeIds: string[];
  /** Entries the source named that we refused to use. Health debt, not deletion. */
  debt: number;
  /**
   * Whether the listing is known to be exhaustive.
   *
   * False means "we could not see all of them", which is different from an
   * empty list meaning "there are none". Retirement keys on this: retiring from
   * a partial listing would delete artifacts that merely failed to enumerate.
   */
  complete: boolean;
}

export interface AcquiredAttachment {
  ref: AttachmentRef;
  bytes: Buffer;
}

export interface Acquisition {
  acquired: AcquiredAttachment[];
  /** Attachments that should be stored and are not. Health debt, never cursor. */
  debt: number;
  listingComplete: boolean;
  /** See `AttachmentListing.listedNativeIds` — the retirement input. */
  listedNativeIds: string[];
  /**
   * The ceiling actually applied while fetching.
   *
   * Carried rather than re-read at persistence time. `artifactMaxBytes()` reads
   * the environment, so a re-read could return a DIFFERENT number than the one
   * the bytes were accepted under — and a store-side ceiling below the
   * transport ceiling turns an already-downloaded attachment into a hard throw
   * inside the parent's transaction, rolling back a page that was fine.
   */
  maxBytes: number;
}

/**
 * Reduce an upstream download link to a path under the configured origin.
 *
 * Upstream metadata is untrusted input. `getBytes` sends the connector's
 * Authorization header, so a link that escaped to another origin would hand the
 * enterprise credential to whatever host the link named. The only safe reading
 * of a download link is "a path within the system we are already talking to".
 *
 * Returns null when the link cannot be reduced to that. Null is a refusal, and
 * the caller counts it as debt rather than following it.
 */
export function safeDownloadPath(link: string | null | undefined): string | null {
  if (typeof link !== "string" || link.length === 0) return null;
  // Control characters would let a header or path be split downstream.
  if (CONTROL.test(link)) return null;
  // A scheme means an absolute URL, and a leading `//` is protocol-relative —
  // both name an origin of the link's choosing rather than ours.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(link) || link.startsWith("//")) return null;
  if (!link.startsWith("/")) return null;

  // Resolve against a placeholder origin purely to normalise dot segments, then
  // confirm nothing climbed out. Decoding happens once, inside URL parsing.
  let resolved: URL;
  try {
    resolved = new URL(link, "https://placeholder.invalid/");
  } catch {
    return null;
  }
  if (resolved.origin !== "https://placeholder.invalid") return null;
  const normalised = resolved.pathname + resolved.search;
  // `..` cannot survive normalisation; if it somehow appears, refuse.
  if (normalised.includes("..")) return null;
  return normalised;
}

/**
 * Turn one raw upstream entry into either a usable ref or a counted refusal.
 *
 * Shared by both connectors because the POLICY is shared: identity decides
 * presence, usability decides fetchability, and the two are reported apart.
 */
interface Entry {
  /** Present only when the source named an id we can reconcile against. */
  nativeId: string | null;
  ref: AttachmentRef | null;
}

function buildEntry(raw: {
  id: unknown;
  revision: unknown;
  mediaType: unknown;
  filename: unknown;
  downloadPath: string | null;
}): Entry {
  const id = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : "";
  // An id we cannot trust cannot authorise anything. It is not "an attachment
  // that failed" — we do not know WHICH attachment it is, so it can neither be
  // fetched nor keep anything alive, and the caller downgrades completeness.
  if (!NATIVE_ID.test(id)) return { nativeId: null, ref: null };

  const revision = String(raw.revision ?? "");
  const mediaType = checkedText(raw.mediaType, MAX_MEDIA_TYPE);
  const filename = checkedText(raw.filename, MAX_FILENAME);
  if (
    !REVISION.test(revision) ||
    mediaType === INVALID ||
    filename === INVALID ||
    raw.downloadPath === null
  )
    // Known id, unusable entry: still LISTED, so nothing of its is retired.
    return { nativeId: id, ref: null };

  return {
    nativeId: id,
    ref: {
      nativeId: id,
      revision,
      mediaType: mediaType ?? DEFAULT_MEDIA_TYPE,
      filename,
      downloadPath: raw.downloadPath,
    },
  };
}

/** Fold a batch of raw entries into refs, ids and debt. */
function collect(rawEntries: Entry[]): {
  refs: AttachmentRef[];
  listedNativeIds: string[];
  debt: number;
  anyUnidentifiable: boolean;
} {
  const refs: AttachmentRef[] = [];
  const listedNativeIds: string[] = [];
  let debt = 0;
  let anyUnidentifiable = false;
  for (const e of rawEntries) {
    if (e.nativeId === null) {
      anyUnidentifiable = true;
      debt += 1;
      continue;
    }
    listedNativeIds.push(e.nativeId);
    if (e.ref === null) debt += 1;
    else refs.push(e.ref);
  }
  return { refs, listedNativeIds, debt, anyUnidentifiable };
}

/**
 * Confluence attachments for one page, paginated to exhaustion.
 *
 * Completeness is taken from the response's OWN paging metadata rather than
 * inferred from `results.length < limit`. Confluence DC caps `limit` server
 * side, so a request for 50 that legitimately returns 25 of 200 would satisfy
 * the inferred test and declare the listing complete — retiring 175 live
 * attachments. `_links.next` is the server telling us there is more; `size` and
 * `limit` are cross-checks for responses that omit it.
 */
export async function listConfluenceAttachments(
  client: DcClient,
  pageId: string,
  fetchJson: (path: string) => Promise<any>,
  maxPages = 40,
): Promise<AttachmentListing> {
  const refs: AttachmentRef[] = [];
  const listedNativeIds: string[] = [];
  let debt = 0;
  let unidentifiable = false;
  let start = 0;
  const limit = 50;

  for (let page = 0; page < maxPages; page++) {
    const data = await fetchJson(
      `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?limit=${limit}&start=${start}&expand=version,metadata`,
    );
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    const batch = collect(
      results.map((a) =>
        buildEntry({
          id: a?.id,
          revision: a?.version?.number ?? 1,
          mediaType: a?.metadata?.mediaType,
          filename: a?.title,
          downloadPath: safeDownloadPath(a?._links?.download),
        }),
      ),
    );
    refs.push(...batch.refs);
    listedNativeIds.push(...batch.listedNativeIds);
    debt += batch.debt;
    unidentifiable ||= batch.anyUnidentifiable;

    const hasNext = typeof data?._links?.next === "string" && data._links.next.length > 0;
    if (!hasNext) {
      // No `next` link. Believe it only if the page is also self-consistent:
      // a server that returned a full page AND omitted `next` is ambiguous, and
      // ambiguity here costs live attachments.
      const served = Number(data?.size ?? results.length);
      const allowed = Number(data?.limit ?? limit);
      const ambiguous = Number.isFinite(allowed) && served >= allowed && results.length > 0;
      return { refs, listedNativeIds, debt, complete: !ambiguous && !unidentifiable };
    }
    // A page that advertises more but delivers nothing would loop forever.
    if (results.length === 0) return { refs, listedNativeIds, debt, complete: false };
    start += results.length;
  }
  // Ran out of pages before the source ran out of attachments.
  return { refs, listedNativeIds, debt, complete: false };
}

/**
 * Jira attachments come with the issue, so there is no second call and no
 * pagination — but they only come with it if the field was REQUESTED.
 *
 * `undefined` therefore means "not requested / not returned", which is not the
 * same as `[]` meaning "requested, and there are none". Treating the first as
 * the second would retire every stored Jira attachment on the first sync that
 * forgot the field, which is exactly what the previous version did.
 */
export function listJiraAttachments(fields: any, baseUrl: string): AttachmentListing {
  const raw = fields?.attachment;
  if (!Array.isArray(raw)) return { refs: [], listedNativeIds: [], debt: 0, complete: false };

  const batch = collect(
    raw.map((a: any) =>
      buildEntry({
        id: a?.id,
        // Jira attachments are immutable: replacing one yields a new id, so
        // there is no version to track and a constant is the honest token.
        revision: "1",
        mediaType: a?.mimeType,
        filename: a?.filename,
        downloadPath: sameOriginPath(a?.content, baseUrl),
      }),
    ),
  );
  return {
    refs: batch.refs,
    listedNativeIds: batch.listedNativeIds,
    debt: batch.debt,
    complete: !batch.anyUnidentifiable,
  };
}

/**
 * Reduce an absolute Jira URL to a path RELATIVE TO THE CONFIGURED BASE.
 *
 * Two separate things are being enforced, and missing either one is a live bug.
 *
 * ORIGIN. The origin is compared, not discarded. Keeping just the path of
 * `https://evil.example/secure/attachment/1/x` would produce a perfectly valid
 * path that we would then fetch from the real Jira with a real credential —
 * turning an attacker-controlled field into a request of our own making.
 *
 * CONTEXT PATH. Every other download path in this connector is relative to
 * `client.baseUrl`, because `getBytes` builds `new URL(baseUrl + path)`. A Jira
 * deployed under a context path — the normal case for Data Center — reports
 * `https://corp.example/jira/secure/attachment/10/a.pdf`, and returning that
 * whole pathname yields `https://corp.example/jira/jira/secure/...` on fetch.
 * So the base pathname is stripped, and the URL must actually lie beneath it.
 *
 * The containment check is on SEGMENT boundaries. A prefix test would accept
 * `/jiraevil/...` under a `/jira` base, which is a different application on the
 * same host receiving our credential.
 */
export function sameOriginPath(absolute: unknown, baseUrl: string): string | null {
  if (typeof absolute !== "string" || absolute.length === 0) return null;
  if (CONTROL.test(absolute)) return null;
  let configured: URL;
  try {
    configured = new URL(baseUrl);
  } catch {
    return null;
  }
  let u: URL;
  try {
    u = new URL(absolute, configured);
  } catch {
    return null;
  }
  if (u.origin !== configured.origin) return null;

  // Trailing slash removed so `/jira` and `/jira/` behave identically; a root
  // base becomes "" and strips nothing.
  const context = configured.pathname.replace(/\/+$/, "");
  if (context.length === 0) return safeDownloadPath(u.pathname + u.search);

  // Segment boundary, so a `/jira` base cannot swallow `/jiraevil` — a
  // different application on the same host receiving our credential.
  //
  // Honest note on its strength: mutating this to a bare `startsWith(context)`
  // fails NO test today, because a boundary violation leaves a remainder with
  // no leading slash (`/jiraevil/x` -> `evil/x`) and `safeDownloadPath` refuses
  // relative paths. It is kept because that is a coincidence of a downstream
  // function, not a property this one should lean on, and both layers are
  // pinned separately.
  const withinContext = u.pathname === context || u.pathname.startsWith(`${context}/`);
  // Same origin but outside our context is a refusal, not a rewrite: it is
  // still a credentialed request we would be making on the source's say-so.
  if (!withinContext) return null;

  const remainder = u.pathname.slice(context.length) || "/";
  return safeDownloadPath(remainder + u.search);
}

/**
 * Download every fetchable attachment, classifying what fails.
 *
 * Runs BEFORE the transaction. A refusal here must not roll back a page that is
 * otherwise perfectly good, so failures are returned as debt rather than thrown.
 */
export async function acquireAttachments(
  client: DcClient,
  listing: AttachmentListing,
  onRefusal?: (ref: AttachmentRef, reason: string) => void,
): Promise<Acquisition> {
  // Read ONCE and carry it, so the transport ceiling and the artifact ceiling
  // cannot drift apart into two different numbers.
  const maxBytes = artifactMaxBytes();
  const acquired: AcquiredAttachment[] = [];
  // Listing refusals are already debt before a single byte is fetched.
  let debt = listing.debt;
  for (const ref of listing.refs) {
    try {
      const bytes = await getBytes(client, ref.downloadPath, maxBytes);
      acquired.push({ ref, bytes });
    } catch (err) {
      debt += 1;
      const reason =
        err instanceof ResponseTooLarge
          ? `too large (${err.observed} > ${err.limit})`
          : `fetch failed: ${(err as Error).message}`;
      onRefusal?.(ref, reason);
    }
  }
  return {
    acquired,
    debt,
    listingComplete: listing.complete,
    listedNativeIds: listing.listedNativeIds,
    maxBytes,
  };
}

/**
 * Persist acquired attachments and reconcile vanished ones, inside the parent's
 * transaction.
 *
 * Retirement is gated on a COMPLETE listing. Retiring from a partial one would
 * delete artifacts that merely failed to enumerate — the same
 * absence-reads-as-deletion mistake the filesystem walk had to avoid.
 *
 * Prior revisions of a native id that is still present are kept: Confluence
 * revision history is evidence, and a citation against version 2 must not
 * dissolve because version 3 exists.
 */
export async function persistAttachments(
  tx: Tx,
  args: {
    tenant: string;
    source: string;
    docId: string;
    acquisition: Acquisition;
  },
): Promise<void> {
  const { tenant, source, docId, acquisition } = args;
  for (const { ref, bytes } of acquisition.acquired)
    await publishArtifactVersion(tx, {
      tenant,
      source,
      nativeId: ref.nativeId,
      revision: ref.revision,
      docId,
      mediaType: ref.mediaType,
      filename: ref.filename,
      bytes,
      // The ceiling the bytes were ACCEPTED under, not whatever the environment
      // says now.
      maxBytes: acquisition.maxBytes,
    });

  if (!acquisition.listingComplete) return;

  // Only native ids the source no longer lists are retired. A refused download
  // does not remove its id from the listing, so it is not retirement-eligible —
  // which is what stops an oversized attachment from being deleted for being
  // oversized.
  const present = new Set(acquisition.listedNativeIds);
  const existing = await tx.query(
    "SELECT DISTINCT native_id FROM artifact_versions" +
      " WHERE tenant = $1 AND source = $2 AND doc_id = $3",
    [tenant, source, docId],
  );
  for (const row of existing.rows as Array<{ native_id: string }>) {
    if (present.has(row.native_id)) continue;
    const revisions = await tx.query(
      "SELECT revision FROM artifact_versions" +
        " WHERE tenant = $1 AND source = $2 AND doc_id = $3 AND native_id = $4",
      [tenant, source, docId, row.native_id],
    );
    for (const r of revisions.rows as Array<{ revision: string }>)
      await retireArtifactVersion(tx, {
        tenant,
        source,
        nativeId: row.native_id,
        revision: r.revision,
      });
  }
}
