/**
 * Path canonicalization for filesystem-sourced documents.
 *
 * A document id derived from a path is a join key: links resolve through it,
 * citations quote it, reconcile tombstones by it. So the same file must produce
 * the same id on every platform and through every spelling of its path, and no
 * spelling may name a file outside the root.
 *
 * All of this is pure string work over LOGICAL paths. Nothing here touches the
 * filesystem, because the containment decision has to be made about the path a
 * caller supplied rather than about whatever it currently resolves to.
 */

import { posix } from "node:path";

/** Windows drive letter (`C:`) or UNC (`\\host\share`) prefix. */
const DRIVE_OR_UNC = /^([a-zA-Z]:|\\\\|\/\/)/;

export interface CanonicalPathError {
  reason: "absolute" | "escapes-root" | "empty" | "encoded" | "control-character";
  detail: string;
}

/**
 * A relative path reduced to one canonical spelling, or a typed refusal.
 *
 * Refusals are values rather than exceptions: every caller here is inside a
 * per-item loop that must classify the outcome (skip vs failure) rather than
 * abort the walk.
 */
export type CanonicalPath = { ok: true; path: string } | { ok: false; error: CanonicalPathError };

/**
 * Canonicalize a path relative to the ingest root.
 *
 * Order is deliberate. Separators are unified first so `..\..` is seen as
 * traversal on every platform; Unicode is normalized so a composed and a
 * decomposed spelling of the same name are one id rather than two documents;
 * dot segments are removed last so containment is judged on the reduced form
 * rather than the literal one.
 */
export function canonicalRelPath(raw: string): CanonicalPath {
  if (raw.length === 0) return { ok: false, error: { reason: "empty", detail: raw } };

  // Control characters — including the NUL that truncates a C-string path — are
  // refused rather than stripped. A path that means different things to
  // different layers is not a path we should form an identity from.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/[\u0000-\u001f\u007f]/.test(raw))
    return { ok: false, error: { reason: "control-character", detail: raw } };

  // BOTH separators are unified on EVERY platform, not just on Windows. An id is
  // a cross-platform join key: a path recorded on Windows is resolved against a
  // corpus on Linux, so `a\b.md` must canonicalize the same way in both places.
  // Treating `\` as a separator everywhere also means `a\..\..\b` is seen as
  // traversal rather than as one long filename that passes the escape check.
  //
  // The cost is a Linux filename that genuinely contains a backslash, which is
  // legal and vanishingly rare; it splits into segments instead. That direction
  // is safe — it can only ever refuse or over-segment, never let a path escape.
  const slashed = raw.split(/[\\/]/).join("/");

  if (slashed.startsWith("/") || DRIVE_OR_UNC.test(slashed))
    return { ok: false, error: { reason: "absolute", detail: raw } };

  // NFC so that "café" written composed and decomposed is ONE document. Without
  // it macOS (which stores NFD) and Linux produce different ids for the same
  // file, and a link written on one platform dangles on the other.
  const normalized = slashed.normalize("NFC");

  // posix.normalize collapses `.` and `..`. A result that still begins with
  // `..` escaped the root; `posix.normalize` cannot remove it because there is
  // nothing above the root to remove it against.
  const reduced = posix.normalize(normalized);
  if (reduced === ".." || reduced.startsWith("../") || reduced === "." || reduced.length === 0)
    return { ok: false, error: { reason: "escapes-root", detail: raw } };

  return { ok: true, path: reduced.replace(/^\.\//, "") };
}

/**
 * Resolve a Markdown link target against the linking document's directory.
 *
 * Percent-decoded exactly ONCE. Decoding repeatedly would let `%252e%252e%252f`
 * become `../` after two passes — an encoded traversal that survives a single
 * decode and therefore survives the containment check applied after it.
 */
export function resolveLinkTarget(fromDir: string, target: string): CanonicalPath {
  const withoutFragment = target.split("#")[0] ?? "";
  if (withoutFragment.length === 0)
    return { ok: false, error: { reason: "empty", detail: target } };

  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // Malformed escapes are refused rather than passed through raw: a target we
    // cannot read unambiguously must not become an edge.
    return { ok: false, error: { reason: "encoded", detail: target } };
  }

  // A second decode changing the string means the original was doubly encoded.
  // Treat that as hostile rather than helpfully decoding again.
  try {
    if (decodeURIComponent(decoded) !== decoded)
      return { ok: false, error: { reason: "encoded", detail: target } };
  } catch {
    /* single decode was already final */
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded))
    return { ok: false, error: { reason: "absolute", detail: target } };

  return canonicalRelPath(fromDir.length > 0 ? `${fromDir}/${decoded}` : decoded);
}

/**
 * Case policy for collision detection.
 *
 * EIL preserves the case a file was discovered with — lowercasing ids would
 * make citations disagree with the filesystem an operator is looking at. But
 * `Notes.md` and `notes.md` are the SAME file on macOS and Windows and two
 * files on Linux, so a corpus that contains both is ambiguous no matter which
 * platform ingested it. This key is what makes that ambiguity detectable.
 */
export const caseFoldKey = (path: string): string => path.toLowerCase();
