/**
 * Filesystem and Obsidian ingestion: one walker, two source profiles.
 *
 * TWO PASSES, not one. Discovery enumerates and validates every candidate first,
 * and only then are links resolved and documents built. That ordering is forced
 * by three requirements that a streaming walk cannot satisfy:
 *
 *   - duplicate ids must be refused BEFORE either claimant is ingested, so the
 *     corpus never briefly contains the wrong one;
 *   - shortest-unique wikilink resolution needs the complete listing to know
 *     whether a name is unique;
 *   - reconcile may only tombstone when the whole snapshot is known good, and
 *     "whole" is not knowable until enumeration finishes.
 *
 * Failures are classified rather than thrown. A single unreadable file used to
 * abort the entire ingest; now it is one item failure, disclosed through the
 * coverage report, and — critically — it makes the listing INCOMPLETE so that
 * reconcile cannot mistake a file it failed to read for a file that was deleted.
 */

import { type Dirent, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { CanonicalDoc } from "../contracts/models.js";
import { extractLinks } from "./common.js";
import { firstHeading, parseFrontmatter } from "./frontmatter.js";
import { canonicalRelPath, caseFoldKey, resolveLinkTarget } from "./fspath.js";

/** Files larger than this are refused as item failures, not silently skipped. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export function maxFileBytes(): number {
  const raw = Number(process.env.EIL_FS_MAX_BYTES);
  // Fails SAFE, matching every other ceiling in the codebase: a typo must not
  // become "unlimited", and NaN would disable every `>` comparison silently.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_FILE_BYTES;
}

/**
 * What differs between a curated Obsidian vault and a general directory tree.
 *
 * Everything else — discovery, canonicalization, frontmatter, failure
 * classification, reconcile coupling — is shared, because it is the same job.
 */
export interface FsProfile {
  source: string;
  /** Builds the document id from the canonical relative path. */
  idFor: (relPath: string, explicitId: string | null) => string;
  qualityTier: "curated" | "authored";
  ignoredDirs: ReadonlySet<string>;
  /** Obsidian interprets `[[x]]`; a general tree must not. */
  wikilinks: boolean;
}

/** Portable id alphabet: what survives a URL, a shell and a filename unchanged. */
const PORTABLE_ID = /^[A-Za-z0-9._~-]+$/;

export const obsidianProfile: FsProfile = {
  source: "obsidian",
  // Unchanged from the original connector ON PURPOSE. Introducing a collection
  // segment here would rewrite every existing id, invalidating stored link
  // edges and every citation already issued against this source.
  idFor: (relPath, explicitId) => `obsidian:note:${explicitId ?? relPath.replace(/\.md$/, "")}`,
  qualityTier: "curated",
  ignoredDirs: new Set([".obsidian", ".trash"]),
  wikilinks: true,
};

export const filesystemProfile = (collection: string): FsProfile => ({
  source: "filesystem",
  // The collection segment is what stops two roots that both contain
  // `README.md` from colliding into one document in the same tenant.
  idFor: (relPath, explicitId) =>
    `filesystem:${collection}:${explicitId ?? relPath.replace(/\.md$/, "")}`,
  qualityTier: "authored",
  ignoredDirs: new Set([".git", "node_modules"]),
  wikilinks: false,
});

export type FsSkipReason =
  | "not-markdown"
  | "ignored-directory"
  | "symlink-not-followed"
  | "symlink-escapes-root"
  | "symlink-cycle"
  | "symlink-broken";

export interface FsFailure {
  path: string;
  reason: string;
}

export interface FsSnapshot {
  docs: CanonicalDoc[];
  /** Deliberate exclusions. Policy working, never a gap. */
  skipped: Array<{ path: string; reason: FsSkipReason }>;
  /** Documents that belong in the corpus and are absent. */
  failures: FsFailure[];
  /** Links that could not be resolved unambiguously; visible, not silent. */
  unresolvedLinks: number;
  /**
   * False when ANY failure occurred, including a directory that could not be
   * listed. Reconcile keys off this: a listing that lost files is not a
   * complete listing, and tombstoning from one deletes live documents.
   */
  complete: boolean;
}

interface Candidate {
  absPath: string;
  relPath: string;
  id: string;
  /** Basename without extension, for shortest-unique wikilink resolution. */
  stem: string;
  aliases: string[];
  body: string;
  title: string;
}

export interface WalkOptions {
  followSymlinks?: boolean;
  /** Test seam: lets a realpath failure be injected deterministically, since a
   *  suite running as root cannot provoke EACCES from the filesystem. */
  realpath?: (p: string) => string;
  /** Test seam for the TOCTOU window: a real file cannot be made to grow
   *  between stat and read deterministically, so the advisory size is injected
   *  to under-report while the read returns the true bytes. */
  statSize?: (p: string) => number;
  maxBytes?: number;
  tenant?: string;
  aclGroups?: readonly string[];
}

/**
 * Discover, validate, resolve and normalize an entire tree.
 *
 * Never throws for per-item problems. The only throw is a caller error —
 * an unusable root or an invalid collection — because those make the whole run
 * meaningless rather than partially complete.
 */
export function walkTree(root: string, profile: FsProfile, opts: WalkOptions = {}): FsSnapshot {
  const tenant = opts.tenant ?? "default";
  const limit = opts.maxBytes ?? maxFileBytes();
  const skipped: FsSnapshot["skipped"] = [];
  const failures: FsFailure[] = [];
  const candidates: Candidate[] = [];
  const visited = new Set<string>();
  let unresolvedLinks = 0;

  // ---- pass 1: enumerate and validate ------------------------------------
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A directory we cannot list hides an unknown number of documents, so it
      // is a failure exactly like an unreadable file — and it is what makes the
      // snapshot incomplete, which is what protects the corpus from reconcile.
      failures.push({ path: dir, reason: `cannot list directory: ${(err as Error).message}` });
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!opts.followSymlinks) {
          skipped.push({ path: full, reason: "symlink-not-followed" });
          continue;
        }
        let real: string;
        try {
          real = (opts.realpath ?? realpathSync)(full);
        } catch (err) {
          // A dangling link is policy — the author removed the target. A
          // PERMISSION or I/O failure is not: it means a document may exist
          // that we could not see, which has to make the snapshot incomplete
          // or reconcile will tombstone it as deleted.
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ELOOP")
            skipped.push({
              path: full,
              reason: code === "ELOOP" ? "symlink-cycle" : "symlink-broken",
            });
          else failures.push({ path: full, reason: `cannot resolve link (${code ?? "unknown"})` });
          continue;
        }
        // Containment re-checked after EVERY hop: a chain of links each
        // individually inside the root can still land outside it.
        const rel = relative((opts.realpath ?? realpathSync)(root), real);
        if (rel.startsWith("..") || rel.length === 0) {
          skipped.push({ path: full, reason: "symlink-escapes-root" });
          continue;
        }
        if (visited.has(real)) {
          skipped.push({ path: full, reason: "symlink-cycle" });
          continue;
        }
        visited.add(real);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(real);
        } catch (err) {
          failures.push({
            path: full,
            reason: `cannot stat link target: ${(err as Error).message}`,
          });
          continue;
        }
        // The id comes from the LOGICAL in-root path, never the realpath: the
        // document's identity is where it appears in the tree the operator
        // named, not where the bytes happen to live.
        if (st.isDirectory()) walk(full);
        else consider(full);
        continue;
      }
      if (entry.isDirectory()) {
        if (profile.ignoredDirs.has(entry.name)) {
          skipped.push({ path: full, reason: "ignored-directory" });
          continue;
        }
        walk(full);
        continue;
      }
      consider(full);
    }
  };

  const consider = (absPath: string): void => {
    if (!absPath.endsWith(".md")) {
      skipped.push({ path: absPath, reason: "not-markdown" });
      return;
    }
    const canon = canonicalRelPath(relative(root, absPath).split(sep).join("/"));
    if (!canon.ok) {
      failures.push({ path: absPath, reason: `unusable path: ${canon.error.reason}` });
      return;
    }
    let size: number;
    try {
      size = opts.statSize ? opts.statSize(absPath) : statSync(absPath).size;
    } catch (err) {
      failures.push({ path: absPath, reason: `cannot stat: ${(err as Error).message}` });
      return;
    }
    if (size > limit) {
      failures.push({ path: absPath, reason: `${size} bytes exceeds the ${limit}-byte ceiling` });
      return;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(absPath);
    } catch (err) {
      failures.push({ path: absPath, reason: `cannot read: ${(err as Error).message}` });
      return;
    }
    // The stat above is advisory: a file can grow between stat and read, and it
    // is the ACCEPTED buffer that would be indexed. Refuse on what was actually
    // materialised, not on what was promised.
    if (buf.length > limit) {
      failures.push({
        path: absPath,
        reason: `${buf.length} bytes read exceeds the ${limit}-byte ceiling`,
      });
      return;
    }

    // Strict decode. `readFileSync(path, "utf-8")` substitutes U+FFFD silently,
    // which indexes corrupted bytes as if they were prose.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      failures.push({ path: absPath, reason: "not valid UTF-8" });
      return;
    }

    const fm = parseFrontmatter(text);
    if (fm.error) {
      failures.push({ path: absPath, reason: fm.error });
      return;
    }
    if (fm.matter.id !== undefined && !PORTABLE_ID.test(fm.matter.id)) {
      failures.push({ path: absPath, reason: `frontmatter id is not portable: ${fm.matter.id}` });
      return;
    }

    const relPath = canon.path;
    const stem = (posix.basename(relPath).replace(/\.md$/, "") || relPath).normalize("NFC");
    candidates.push({
      absPath,
      relPath,
      id: profile.idFor(relPath, fm.matter.id ?? null),
      stem,
      aliases: fm.matter.aliases,
      body: fm.body,
      title: fm.matter.title ?? firstHeading(fm.body) ?? stem,
    });
  };

  walk(root);

  // Duplicate ids refused BEFORE either claimant is ingested — otherwise the
  // corpus contains whichever happened to be written last, with no signal that
  // the other exists at all.
  const byId = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byId.get(c.id);
    if (list) list.push(c);
    else byId.set(c.id, [c]);
  }
  const usable: Candidate[] = [];
  for (const [id, claimants] of byId) {
    if (claimants.length === 1) {
      usable.push(claimants[0] as Candidate);
      continue;
    }
    for (const c of claimants)
      failures.push({
        path: c.absPath,
        reason: `duplicate document id ${id}, also claimed by ${claimants
          .filter((o) => o !== c)
          .map((o) => o.relPath)
          .join(", ")}`,
      });
  }

  // ---- pass 2: resolve links and normalize -------------------------------
  const byRelPath = new Map(usable.map((c) => [c.relPath, c]));
  const byFoldedRel = new Map<string, Candidate[]>();
  const byStem = new Map<string, Candidate[]>();
  for (const c of usable) {
    const fold = caseFoldKey(c.relPath);
    byFoldedRel.set(fold, [...(byFoldedRel.get(fold) ?? []), c]);
    // Deduplicated: `aliases: [Target]` on `Target.md` would otherwise insert
    // the same candidate twice and make the document ambiguous with itself.
    for (const key of new Set([c.stem, ...c.aliases].map(caseFoldKey))) {
      const group = byStem.get(key) ?? [];
      if (!group.includes(c)) group.push(c);
      byStem.set(key, group);
    }
  }

  const docs: CanonicalDoc[] = [];
  for (const c of usable) {
    const dir = posix.dirname(c.relPath) === "." ? "" : posix.dirname(c.relPath);
    const links = new Set<string>();

    // Cross-source links (ticket keys, Confluence/Jira URLs) still come from the
    // shared extractor. Wikilinks are excluded here and resolved below against
    // the real listing, because the shared extractor hardcodes the obsidian
    // namespace and assumes every note lives at the root.
    for (const l of extractLinks(c.body, c.id)) if (!l.startsWith("obsidian:note:")) links.add(l);

    for (const m of c.body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = resolveLinkTarget(dir, m[1] as string);
      if (!target.ok) continue; // external URL or refused traversal: not an edge
      const hit = byRelPath.get(target.path) ?? byRelPath.get(`${target.path}.md`);
      // Even an exact spelling is refused when the folded group is ambiguous:
      // `Foo.md` and `foo.md` are ONE file on macOS and Windows, so an edge to
      // either is a guess about which platform the corpus came from.
      if (hit && (byFoldedRel.get(caseFoldKey(hit.relPath)) ?? []).length === 1) links.add(hit.id);
      else if (hit || target.path.endsWith(".md")) unresolvedLinks++;
    }

    if (profile.wikilinks)
      for (const m of c.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const name = (m[1] as string).split("|")[0]?.split("#")[0]?.trim() ?? "";
        if (name.length === 0) continue;
        const exact = byRelPath.get(`${name}.md`) ?? byRelPath.get(name);
        // Same rule on the exact-path fast path, which previously bypassed the
        // folded groups entirely.
        const exactUnambiguous =
          exact && (byFoldedRel.get(caseFoldKey(exact.relPath)) ?? []).length === 1;
        const matches = exactUnambiguous
          ? [exact as Candidate]
          : (byStem.get(caseFoldKey(name)) ?? []);
        // Ambiguous names produce NO edge. Guessing would silently attach a
        // citation-bearing relationship to the wrong document.
        if (matches.length === 1 && matches[0] !== c) links.add((matches[0] as Candidate).id);
        else if (matches.length !== 1) unresolvedLinks++;
      }

    let updatedAt: string | null = null;
    try {
      updatedAt = new Date(statSync(c.absPath).mtimeMs).toISOString();
    } catch {
      /* already read successfully; an mtime we cannot get is not a failure */
    }

    docs.push(
      CanonicalDoc.parse({
        id: c.id,
        tenant,
        source: profile.source,
        title: c.title,
        updatedAt,
        hierarchy: posix.dirname(c.relPath) === "." ? [] : posix.dirname(c.relPath).split("/"),
        // Fail-closed. A filesystem tree has no upstream ACL to mirror, so the
        // only honest widening is an explicit operator flag. POSIX modes are
        // never consulted: local uid/gid has no relationship to the viewer
        // identities EIL authorizes against.
        aclGroups: [...(opts.aclGroups ?? [])],
        qualityTier: profile.qualityTier,
        body: c.body,
        links: [...links],
        // The REAL path, not the id tail. With an explicit frontmatter id these
        // differ by design, and the locator must name a file that exists.
        sourcePath: c.relPath,
      }),
    );
  }

  // Case-only collisions are ambiguous on macOS and Windows even though this
  // Linux walk saw two distinct files. Reported so the corpus is not silently
  // platform-dependent.
  for (const [, group] of byFoldedRel)
    if (group.length > 1)
      failures.push({
        path: (group[0] as Candidate).absPath,
        reason: `case-only path collision: ${group.map((g) => g.relPath).join(", ")}`,
      });

  return { docs, skipped, failures, unresolvedLinks, complete: failures.length === 0 };
}
