/**
 * Filesystem / Markdown ingestion.
 *
 * The load-bearing property is not "markdown files land in the catalog" — it is
 * that a walk which LOST something cannot be mistaken for a walk that found
 * everything. A file EIL failed to read looks exactly like a file the author
 * deleted, and reconcile acts on that difference by tombstoning. So the
 * completeness coupling gets the most scrutiny here.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesystemProfile, obsidianProfile, walkTree } from "../ingest/filesystem.js";
import { firstHeading, parseFrontmatter } from "../ingest/frontmatter.js";
import { canonicalRelPath, resolveLinkTarget } from "../ingest/fspath.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eil-fs-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (rel: string, body: string): string => {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  return full;
};

const fsProfile = filesystemProfile("notes");

describe("path canonicalization", () => {
  it("reduces every spelling of one path to one identity", () => {
    for (const raw of ["a/b.md", "./a/b.md", "a//b.md", "a/./b.md", "a/c/../b.md"])
      expect(canonicalRelPath(raw)).toEqual({ ok: true, path: "a/b.md" });
  });

  it("treats Windows separators as separators, not as filename characters", () => {
    // Without unifying first, `a\..\..\b` reads as one long filename and the
    // traversal is never seen.
    const out = canonicalRelPath("a\\b.md");
    expect(out.ok ? out.path : null).toBe("a/b.md");
  });

  it("refuses absolute, drive and UNC paths", () => {
    for (const raw of ["/etc/passwd", "C:/secrets.md", "\\\\host\\share\\x.md", "//host/share"])
      expect(canonicalRelPath(raw).ok).toBe(false);
  });

  it("refuses any spelling that escapes the root", () => {
    for (const raw of ["../x.md", "a/../../x.md", ".."]) {
      const out = canonicalRelPath(raw);
      expect(out.ok).toBe(false);
      expect(out.ok ? null : out.error.reason).toBe("escapes-root");
    }
  });

  it("refuses control characters rather than stripping them", () => {
    // A NUL truncates the path at the C boundary, so the string EIL reasons
    // about and the file the OS opens can differ.
    expect(canonicalRelPath("a\u0000b.md").ok).toBe(false);
  });

  it("folds Unicode so one file is not two documents", () => {
    const composed = canonicalRelPath("caf\u00e9.md");
    const decomposed = canonicalRelPath("cafe\u0301.md");
    expect(composed.ok && decomposed.ok && composed.path === decomposed.path).toBe(true);
  });
});

describe("link target resolution", () => {
  it("resolves relative targets against the linking document's directory", () => {
    expect(resolveLinkTarget("a/b", "../c/d.md")).toEqual({ ok: true, path: "a/c/d.md" });
    expect(resolveLinkTarget("", "./x.md")).toEqual({ ok: true, path: "x.md" });
  });

  it("decodes percent-encoding exactly once", () => {
    expect(resolveLinkTarget("", "my%20note.md")).toEqual({ ok: true, path: "my note.md" });
    // Doubly encoded traversal: a second decode would yield `../`, which is the
    // whole reason decoding is not applied repeatedly.
    const doubled = resolveLinkTarget("", "%252e%252e%252fescape.md");
    expect(doubled.ok).toBe(false);
    expect(doubled.ok ? null : doubled.error.reason).toBe("encoded");
  });

  it("refuses encoded traversal and external schemes", () => {
    expect(resolveLinkTarget("", "%2e%2e%2fescape.md").ok).toBe(false);
    expect(resolveLinkTarget("", "https://example.com/x.md").ok).toBe(false);
    expect(resolveLinkTarget("", "mailto:a@b.c").ok).toBe(false);
  });

  it("drops the fragment before resolving", () => {
    expect(resolveLinkTarget("", "x.md#section")).toEqual({ ok: true, path: "x.md" });
  });
});

describe("frontmatter is a bounded subset, not YAML", () => {
  it("strips the header from the body and projects the allowlist", () => {
    const out = parseFrontmatter("---\ntitle: Hello\ntags: [a, b]\nsecret: nope\n---\nBody here\n");
    expect(out.error).toBeUndefined();
    expect(out.matter.title).toBe("Hello");
    expect(out.matter.tags).toEqual(["a", "b"]);
    expect(out.body).toBe("Body here\n");
    // The header is no longer searchable prose.
    expect(out.body).not.toContain("title:");
    // A key outside the allowlist is ignored, not projected.
    expect(Object.keys(out.matter)).not.toContain("secret");
  });

  it("reads block sequences", () => {
    const out = parseFrontmatter("---\naliases:\n  - one\n  - two\n---\nx\n");
    expect(out.matter.aliases).toEqual(["one", "two"]);
  });

  it("refuses syntax outside the subset rather than ignoring it", () => {
    // Nested maps and anchors are exactly the object-graph surface this parser
    // exists to not have. Refusing by name beats silently dropping metadata.
    expect(parseFrontmatter("---\nmeta:\n  nested: 1\n---\nx").error).toBeTruthy();
    expect(parseFrontmatter("---\nid: &anchor x\n*ref\n---\nx").error).toBeTruthy();
  });

  it("refuses an unterminated header instead of eating the document", () => {
    const out = parseFrontmatter("---\ntitle: x\nbody continues forever\n");
    expect(out.error).toMatch(/not terminated/);
    expect(out.body).toContain("body continues");
  });

  it("refuses an oversized header", () => {
    const huge = `---\ntitle: x\n${"pad: y\n".repeat(4000)}---\nbody`;
    expect(parseFrontmatter(huge).error).toBeTruthy();
  });

  it("only treats a header at the very first byte as frontmatter", () => {
    // A `---` mid-document is a horizontal rule; consuming it would delete the
    // opening paragraphs of any document that uses one.
    const out = parseFrontmatter("Intro paragraph\n\n---\n\nMore\n");
    expect(out.error).toBeUndefined();
    expect(out.body).toContain("Intro paragraph");
  });

  it("ignores headings inside fenced code when picking a title", () => {
    expect(firstHeading("```sh\n# not a title\n```\n\n# Real Title\n")).toBe("Real Title");
  });
});

describe("discovery, identity and failure classification", () => {
  it("ingests a tree and derives ids from the collection and path", () => {
    write("a/note.md", "# A\nbody");
    const snap = walkTree(root, fsProfile);
    expect(snap.complete).toBe(true);
    expect(snap.docs.map((d) => d.id)).toEqual(["filesystem:notes:a/note"]);
    expect(snap.docs[0]?.title).toBe("A");
    expect(snap.docs[0]?.source).toBe("filesystem");
  });

  it("keeps two roots apart via the collection segment", () => {
    write("README.md", "# One");
    const a = walkTree(root, filesystemProfile("alpha"));
    const b = walkTree(root, filesystemProfile("beta"));
    expect(a.docs[0]?.id).not.toBe(b.docs[0]?.id);
  });

  it("preserves existing Obsidian ids unchanged", () => {
    // Introducing a collection segment here would rewrite every stored id,
    // invalidating link edges and citations already issued.
    write("sub/Note.md", "# N");
    const snap = walkTree(root, obsidianProfile);
    expect(snap.docs[0]?.id).toBe("obsidian:note:sub/Note");
  });

  it("refuses duplicate ids and ingests NEITHER claimant", () => {
    write("one.md", "---\nid: shared\n---\n# One");
    write("two.md", "---\nid: shared\n---\n# Two");
    const snap = walkTree(root, fsProfile);
    expect(snap.docs).toHaveLength(0);
    expect(snap.failures).toHaveLength(2);
    expect(snap.complete).toBe(false);
  });

  it("classifies policy exclusions as skips and lost documents as failures", () => {
    write("keep.md", "# K");
    write("image.png", "binary-ish");
    write(".git/config.md", "# ignored");
    write("huge.md", "x".repeat(200));
    const snap = walkTree(root, fsProfile, { maxBytes: 50 });
    expect(snap.docs.map((d) => d.id)).toEqual(["filesystem:notes:keep"]);
    expect(snap.skipped.map((s) => s.reason)).toContain("not-markdown");
    expect(snap.skipped.map((s) => s.reason)).toContain("ignored-directory");
    // Over the ceiling is a FAILURE — the document belongs in the corpus and is
    // absent — while a .png is policy working.
    expect(snap.failures.some((f) => f.reason.includes("exceeds"))).toBe(true);
    expect(snap.complete).toBe(false);
  });

  it("refuses invalid UTF-8 instead of indexing replacement characters", () => {
    writeFileSync(join(root, "bad.md"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const snap = walkTree(root, fsProfile);
    expect(snap.docs).toHaveLength(0);
    expect(snap.failures[0]?.reason).toMatch(/UTF-8/);
  });

  it("defaults to owner-only ACL and widens only when told", () => {
    write("n.md", "# N");
    expect(walkTree(root, fsProfile).docs[0]?.aclGroups).toEqual([]);
    expect(walkTree(root, fsProfile, { aclGroups: ["eng"] }).docs[0]?.aclGroups).toEqual(["eng"]);
  });
});

describe("symlink policy", () => {
  it("does not follow symlinks by default", () => {
    write("real.md", "# R");
    symlinkSync(join(root, "real.md"), join(root, "link.md"));
    const snap = walkTree(root, fsProfile);
    expect(snap.docs.map((d) => d.id)).toEqual(["filesystem:notes:real"]);
    expect(snap.skipped.map((s) => s.reason)).toContain("symlink-not-followed");
  });

  it("refuses a symlink escaping the root even when following is enabled", () => {
    // The case that matters: a link named like a note, pointing at content the
    // operator never put in the tree, would otherwise be ingested under an
    // in-root id.
    const outside = mkdtempSync(join(tmpdir(), "eil-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "# Secret");
      symlinkSync(join(outside, "secret.md"), join(root, "innocent.md"));
      const snap = walkTree(root, fsProfile, { followSymlinks: true });
      expect(snap.docs).toHaveLength(0);
      expect(snap.skipped.map((s) => s.reason)).toContain("symlink-escapes-root");
      // A refused symlink is policy, not a lost document.
      expect(snap.complete).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("follows an in-root symlink and ids it by its logical path", () => {
    write("real/note.md", "# R");
    symlinkSync(join(root, "real"), join(root, "alias"));
    const snap = walkTree(root, fsProfile, { followSymlinks: true });
    const ids = snap.docs.map((d) => d.id).sort();
    // Identity follows where the document APPEARS, not where the bytes live.
    expect(ids).toContain("filesystem:notes:alias/note");
    expect(ids).toContain("filesystem:notes:real/note");
  });

  it("terminates on a symlink cycle", () => {
    mkdirSync(join(root, "d"));
    symlinkSync(join(root, "d"), join(root, "d", "self"));
    const snap = walkTree(root, fsProfile, { followSymlinks: true });
    expect(snap.skipped.map((s) => s.reason)).toContain("symlink-cycle");
  });
});

describe("link resolution against the real listing", () => {
  it("resolves relative markdown links to ids in the SAME namespace", () => {
    // The hardcoded `obsidian:note:` prefix in the shared extractor would have
    // pointed filesystem edges at documents that do not exist.
    write("a/one.md", "See [two](../b/two.md)");
    write("b/two.md", "# Two");
    const snap = walkTree(root, fsProfile);
    const one = snap.docs.find((d) => d.id.endsWith("a/one"));
    expect(one?.links.map((l) => l.id)).toEqual(["filesystem:notes:b/two"]);
  });

  it("resolves a nested wikilink that the old root-only mapping missed", () => {
    write("sub/Target.md", "# T");
    write("Index.md", "See [[Target]]");
    const snap = walkTree(root, obsidianProfile);
    const index = snap.docs.find((d) => d.id === "obsidian:note:Index");
    expect(index?.links.map((l) => l.id)).toEqual(["obsidian:note:sub/Target"]);
  });

  it("produces no edge for an ambiguous wikilink, and counts it", () => {
    write("a/Dup.md", "# A");
    write("b/Dup.md", "# B");
    write("Index.md", "See [[Dup]]");
    const snap = walkTree(root, obsidianProfile);
    const index = snap.docs.find((d) => d.id === "obsidian:note:Index");
    expect(index?.links).toEqual([]);
    expect(snap.unresolvedLinks).toBeGreaterThan(0);
  });

  it("does not interpret wikilinks in a general filesystem tree", () => {
    write("Target.md", "# T");
    write("Index.md", "See [[Target]]");
    const snap = walkTree(root, fsProfile);
    const index = snap.docs.find((d) => d.id === "filesystem:notes:Index");
    expect(index?.links).toEqual([]);
  });

  it("still extracts cross-source links", () => {
    write("n.md", "Fixes PAY-4242");
    const snap = walkTree(root, fsProfile);
    expect(snap.docs[0]?.links.map((l) => l.id)).toContain("jira:issue:PAY-4242");
  });
});

describe("completeness is what protects the corpus from reconcile", () => {
  it("a whole walk is complete", () => {
    write("a.md", "# A");
    expect(walkTree(root, fsProfile).complete).toBe(true);
  });

  it("ANY failure makes the listing incomplete", () => {
    // This is the coupling. An unreadable file drops out of the listing, and a
    // listing reported complete would have reconcile tombstone a document whose
    // file is still on disk.
    write("a.md", "# A");
    writeFileSync(join(root, "bad.md"), Buffer.from([0xff, 0xfe]));
    const snap = walkTree(root, fsProfile);
    expect(snap.docs.length).toBeGreaterThan(0);
    expect(snap.failures.length).toBeGreaterThan(0);
    expect(snap.complete).toBe(false);
  });

  it("an unlistable directory is a failure, not an empty directory", () => {
    // A directory EIL cannot read hides an unknown number of documents. Treating
    // it as empty is the same lie as treating an unreadable file as deleted.
    const denied = join(root, "denied");
    mkdirSync(denied);
    write("denied/hidden.md", "# H");
    const { chmodSync } = require("node:fs");
    chmodSync(denied, 0o000);
    try {
      const snap = walkTree(root, fsProfile);
      // Root may be able to read regardless; only assert when the OS enforced it.
      if (snap.failures.some((f) => f.reason.includes("cannot list"))) {
        expect(snap.complete).toBe(false);
      }
    } finally {
      chmodSync(denied, 0o755);
    }
  });
});

describe("a partial walk must not tombstone what it failed to see", () => {
  /**
   * The walker's `complete` flag only matters because the runner honours it.
   * This drives the PRODUCTION dispatcher so the coupling is proven end to end
   * rather than inferred from a boolean.
   */
  it("skips reconcile while incomplete, then tombstones once a whole walk confirms the deletion", async () => {
    const { openTestDb } = await import("./helpers/db.js");
    const { REGISTRY, runSource } = await import("../ingest/registry.js");
    const { connect } = await import("../db.js");
    await (await openTestDb()).end();

    const spec = REGISTRY.filesystem as import("../ingest/registry.js").SourceSpec;
    const run = () => runSource(spec, { tenant: "default", root, collection: "notes" } as never);

    write("keep.md", "# Keep");
    write("gone.md", "# Gone");
    await run();

    const live = async (): Promise<string[]> => {
      const c = await connect();
      try {
        const r = await c.query(
          "SELECT id FROM documents WHERE tenant = 'default' AND source = 'filesystem'" +
            " AND tombstoned_at IS NULL ORDER BY id",
        );
        return r.rows.map((x: { id: string }) => x.id);
      } finally {
        await c.end();
      }
    };
    expect(await live()).toEqual(["filesystem:notes:gone", "filesystem:notes:keep"]);

    // Delete one file AND break another. The deletion is real; the breakage
    // means this walk cannot know what else it missed.
    unlinkSync(join(root, "gone.md"));
    writeFileSync(join(root, "broken.md"), Buffer.from([0xff, 0xfe]));
    await run();

    // Precondition: this run really was incomplete, or the assertion below
    // would pass for the wrong reason.
    expect(walkTree(root, fsProfile).complete).toBe(false);
    // `gone` is genuinely deleted, but an incomplete listing is not evidence of
    // that — tombstoning here would also remove anything the walk merely failed
    // to read.
    expect(await live()).toContain("filesystem:notes:gone");

    // Repair the breakage. Now the listing is whole and the deletion is real
    // evidence, so the tombstone is correct.
    unlinkSync(join(root, "broken.md"));
    expect(walkTree(root, fsProfile).complete).toBe(true);
    await run();
    expect(await live()).toEqual(["filesystem:notes:keep"]);
  });
});

describe("round-two corrections", () => {
  it("refuses an edge to a case-colliding target even on an exact spelling", () => {
    // `Foo.md` and `foo.md` are ONE file on macOS and Windows. An edge to
    // either is a guess about which platform produced the corpus, so the exact
    // spelling must not bypass the ambiguity rule.
    write("Foo.md", "# Upper");
    write("foo.md", "# Lower");
    write("Index.md", "See [x](Foo.md)");
    const snap = walkTree(root, fsProfile);
    const index = snap.docs.find((d) => d.id.endsWith("Index"));
    expect(index?.links).toEqual([]);
    expect(snap.unresolvedLinks).toBeGreaterThan(0);
  });

  it("refuses a case-colliding wikilink on the exact-path fast path too", () => {
    write("Foo.md", "# Upper");
    write("foo.md", "# Lower");
    write("Index.md", "See [[Foo]]");
    const snap = walkTree(root, obsidianProfile);
    const index = snap.docs.find((d) => d.id === "obsidian:note:Index");
    expect(index?.links).toEqual([]);
  });

  it("treats a permission failure resolving a symlink as a failure, not a broken link", () => {
    // Injected rather than provoked: a suite running as root cannot make the
    // filesystem return EACCES, so the classification would be untested.
    write("real.md", "# R");
    symlinkSync(join(root, "real.md"), join(root, "link.md"));
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const snap = walkTree(root, fsProfile, {
      followSymlinks: true,
      realpath: (p: string) => {
        if (p.endsWith("link.md")) throw denied;
        return p;
      },
    });
    expect(snap.failures.some((f) => f.reason.includes("EACCES"))).toBe(true);
    // The consequence that matters: a document may exist that we could not see.
    expect(snap.complete).toBe(false);
  });

  it("still treats a dangling symlink as policy, not failure", () => {
    write("real.md", "# R");
    symlinkSync(join(root, "nonexistent.md"), join(root, "dead.md"));
    const snap = walkTree(root, fsProfile, { followSymlinks: true });
    expect(snap.skipped.map((s) => s.reason)).toContain("symlink-broken");
    expect(snap.complete).toBe(true);
  });

  it("refuses a file that grew past the ceiling between stat and read", () => {
    // TOCTOU. The stat is advisory; what would be INDEXED is the buffer
    // actually materialised. A file cannot be made to grow mid-call
    // deterministically, so the advisory size is injected to under-report —
    // without that seam this test passes on the pre-read check alone and proves
    // nothing about the window.
    write("grows.md", "x".repeat(100));
    const snap = walkTree(root, fsProfile, { maxBytes: 50, statSize: () => 1 });
    expect(snap.failures.some((f) => f.reason.includes("bytes read exceeds"))).toBe(true);
    expect(snap.docs).toHaveLength(0);
  });

  it("the pre-read check still refuses without reading an oversized file", () => {
    write("big.md", "x".repeat(100));
    const snap = walkTree(root, fsProfile, { maxBytes: 50 });
    expect(snap.failures.some((f) => f.reason.includes("exceeds"))).toBe(true);
  });

  it("chunks of a filesystem document carry a canonical path and exact line span", async () => {
    const { chunk } = await import("../core/chunker.js");
    write(
      "spans.md",
      "# Title\n\nintro\n\n## Setup\n\nfirst setup\n\n## Other\n\nmiddle\n\n## Setup\n\nsecond setup\n",
    );
    const snap = walkTree(root, fsProfile);
    const chunks = chunk(snap.docs[0] as never);
    const setups = chunks.filter((c) => c.headingPath.endsWith("Setup"));
    // Repeated headings are exactly what a breadcrumb cannot disambiguate.
    expect(setups.length).toBe(2);
    expect(setups[0]?.lineStart).not.toBe(setups[1]?.lineStart);
    for (const c of setups) {
      expect(c.sourcePath).toBe("spans.md");
      expect(c.lineStart).toBeGreaterThanOrEqual(1);
      expect(c.lineEnd).toBeGreaterThanOrEqual(c.lineStart as number);
    }
  });

  it("leaves converted sources without a fabricated line span", async () => {
    const { chunk } = await import("../core/chunker.js");
    const { normalize } = await import("../ingest/confluence.js");
    const doc = normalize({ id: "p1", title: "T", body: "# H\n\nbody" } as never);
    for (const c of chunk(doc)) {
      // A Confluence body is converted from XHTML; a line number would be
      // precision that does not exist.
      expect(c.sourcePath ?? null).toBeNull();
      expect(c.lineStart ?? null).toBeNull();
    }
  });
});

describe("collection names must be stable identifiers", () => {
  it("rejects dot-only collections", async () => {
    const { openTestDb } = await import("./helpers/db.js");
    const { REGISTRY, runSource } = await import("../ingest/registry.js");
    await (await openTestDb()).end();
    const spec = REGISTRY.filesystem as import("../ingest/registry.js").SourceSpec;
    for (const bad of [".", "..", "...", ""])
      await expect(
        runSource(spec, { tenant: "default", root, collection: bad } as never),
      ).rejects.toThrow(/portable name/);
  });
});

describe("resolution debt is a health signal, not a silent success", () => {
  it("an unresolved link makes the run unhealthy while still allowing reconcile", async () => {
    const { openTestDb } = await import("./helpers/db.js");
    const { REGISTRY, runSource } = await import("../ingest/registry.js");
    const { connect } = await import("../db.js");
    const { coverageFor } = await import("../coverage.js");
    await (await openTestDb()).end();
    const spec = REGISTRY.filesystem as import("../ingest/registry.js").SourceSpec;

    // A link to a target that does not exist: resolution debt with NO item
    // failure. The earlier fixture used a case collision, which ALSO raises a
    // failure — so item_failures was non-zero either way and the test passed
    // even with the debt uncounted. This is the only shape that isolates it.
    write("Index.md", "See [x](missing.md)");
    await runSource(spec, { tenant: "default", root, collection: "notes" } as never);

    const c = await connect();
    try {
      // Precondition: the documents really did ingest, so the unhealthy verdict
      // below is about the debt and not about a failed walk.
      const docs = await c.query(
        "SELECT count(*)::int AS n FROM documents WHERE source = 'filesystem'",
      );
      expect(docs.rows[0].n).toBeGreaterThan(0);

      // Precondition: the walk itself is CLEAN — this is debt, not a lost file,
      // so reconcile remains safe while the run is still unhealthy.
      expect(walkTree(root, fsProfile).failures).toEqual([]);
      expect(walkTree(root, fsProfile).unresolvedLinks).toBeGreaterThan(0);

      const cov = await coverageFor(c, { tenant: "default", principal: "reader", groups: [] }, [
        "filesystem",
      ]);
      const row = cov.sources.find((s) => s.source === "filesystem");
      expect(row?.item_failures).toBeGreaterThan(0);
      expect(cov.complete).toBe(false);
    } finally {
      await c.end();
    }
  });
});

describe("locators name the real file, not the id", () => {
  it("an explicit frontmatter id keeps identity while the locator follows the move", async () => {
    const { chunk } = await import("../core/chunker.js");
    for (const profile of [fsProfile, obsidianProfile]) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      write("docs/runbook.md", "---\nid: payments\n---\n# R\n\nbody");
      const before = walkTree(root, profile);
      const idBefore = before.docs[0]?.id as string;
      expect(chunk(before.docs[0] as never)[0]?.sourcePath).toBe("docs/runbook.md");

      // Same explicit id, different path.
      rmSync(join(root, "docs"), { recursive: true, force: true });
      write("moved/elsewhere.md", "---\nid: payments\n---\n# R\n\nbody");
      const after = walkTree(root, profile);
      // Identity survives the move — that is what the explicit id is for.
      expect(after.docs[0]?.id).toBe(idBefore);
      // ...and the locator names where the file actually is now. Deriving the
      // path from the id would have produced `payments.md`, which never existed.
      expect(chunk(after.docs[0] as never)[0]?.sourcePath).toBe("moved/elsewhere.md");
    }
  });

  it("gives each packed chunk of one long section its own narrower range", async () => {
    const { chunk } = await import("../core/chunker.js");
    const para = (n: number) => `${`para ${n} `.repeat(200)}`;
    write("long.md", `# T\n\n## S\n\n${[1, 2, 3, 4, 5].map(para).join("\n\n")}\n`);
    const snap = walkTree(root, fsProfile);
    const chunks = chunk(snap.docs[0] as never).filter((c) => c.headingPath.endsWith("S"));
    // Precondition: the section really did split, or "ranges differ" is vacuous.
    // Spans come from `pack` itself now, so they are per-piece rather than the
    // section's — that earlier claim was corrected.
    expect(chunks.length).toBeGreaterThan(1);
    const spans = chunks.map((c) => `${c.lineStart}-${c.lineEnd}`);
    expect(new Set(spans).size).toBeGreaterThan(1);

    // Every chunk's text must actually live inside the lines it claims.
    const lines = (snap.docs[0] as never as { body: string }).body.split("\n");
    for (const c of chunks) {
      const window = lines.slice((c.lineStart as number) - 1, c.lineEnd as number).join("\n");
      expect(window).toContain(c.text.slice(0, 40));
    }
  });

  it("a hard-wrapped single line honestly reports that one line for every piece", async () => {
    const { chunk } = await import("../core/chunker.js");
    // One physical line longer than MAX_CHARS: pack slices it, and every slice
    // genuinely comes from the same source line.
    write("wrap.md", `# T\n\n${"x".repeat(9000)}\n`);
    const snap = walkTree(root, fsProfile);
    const chunks = chunk(snap.docs[0] as never);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.lineStart).toBe(c.lineEnd);
    expect(new Set(chunks.map((c) => c.lineStart)).size).toBe(1);
  });

  it("resolves a wikilink when an alias repeats the document's own stem", () => {
    // `aliases: [Target]` on `Target.md` inserted the candidate twice, making
    // the document ambiguous with itself and silently dropping the edge.
    // NESTED, so `[[Target]]` cannot be served by the exact-path fast path and
    // must go through the stem/alias index — which is where the duplicate was.
    // A root-level file would resolve by exact path and never exercise it.
    write("sub/Target.md", "---\naliases: [Target]\n---\n# T");
    write("Index.md", "See [[Target]]");
    const snap = walkTree(root, obsidianProfile);
    const index = snap.docs.find((d) => d.id === "obsidian:note:Index");
    expect(index?.links.map((l) => l.id)).toEqual(["obsidian:note:sub/Target"]);
    expect(snap.unresolvedLinks).toBe(0);
  });
});

describe("locator metadata backfills without disturbing vectors", () => {
  it("a pre-0029 chunk with NULL locator backfills on reingest, vector intact", async () => {
    const { openTestDb } = await import("./helpers/db.js");
    const { connect } = await import("../db.js");
    const db = await openTestDb();
    try {
      write("n.md", "# T\n\nstable body");
      const doc = walkTree(root, fsProfile).docs[0] as never;
      const { upsertDocument } = await import("../store.js");
      await upsertDocument(db, doc);

      // Simulate the pre-migration state faithfully: the locator columns are
      // NULL *and* the stored document hash is the one computed before
      // `sourcePath` joined it. Nulling only the chunk columns would have been
      // an artificial state — the document gate would short-circuit and the
      // test would prove nothing about the real migration path.
      await db.query("UPDATE chunks SET source_path = NULL, line_start = NULL, line_end = NULL");
      const { contentHash } = await import("../contracts/models.js");
      const preMigration = contentHash({
        ...(doc as never as object),
        sourcePath: undefined,
      } as never);
      await db.query("UPDATE documents SET content_hash = $1", [preMigration]);
      await db.query(
        "INSERT INTO chunk_vectors (tenant, doc_id, seq, ord, embed_model, embedding)" +
          " SELECT tenant, doc_id, seq, 0, 'test-model', ARRAY[0.1,0.2]::float4[] FROM chunks" +
          " ON CONFLICT DO NOTHING",
      );
      const before = await db.query("SELECT count(*)::int AS n FROM chunk_vectors");

      // Reingest the IDENTICAL document: text unchanged, so the equal-hash path
      // runs — which previously skipped the row entirely.
      await upsertDocument(db, doc);

      const after = await db.query(
        "SELECT source_path, line_start, line_end FROM chunks ORDER BY seq LIMIT 1",
      );
      expect(after.rows[0].source_path).toBe("n.md");
      expect(after.rows[0].line_start).not.toBeNull();
      const vectors = await db.query("SELECT count(*)::int AS n FROM chunk_vectors");
      // The vector survived: identical text must not force a re-embed.
      expect(vectors.rows[0].n).toBe(before.rows[0].n);
      expect(vectors.rows[0].n).toBeGreaterThan(0);
    } finally {
      await db.end();
    }
  });

  it("the schema refuses a half-populated locator", async () => {
    const { openTestDb } = await import("./helpers/db.js");
    const db = await openTestDb();
    try {
      const seed = async (cols: string, vals: string) =>
        db
          .query(
            "INSERT INTO documents (id, tenant, source, title, quality_tier, content_hash, body, ingested_by)" +
              ` VALUES ('d1','default','filesystem','t','authored','h','b','me')` +
              " ON CONFLICT DO NOTHING",
          )
          .then(() =>
            db.query(
              `INSERT INTO chunks (tenant, doc_id, seq, heading_path, text, content_hash, ${cols})` +
                ` VALUES ('default','d1',0,'h','t','ch', ${vals})`,
            ),
          );
      // A range with no file to open.
      await expect(seed("line_start, line_end", "4, 8")).rejects.toThrow();
      // A file with no range.
      await expect(seed("source_path", "'a.md'")).rejects.toThrow();
    } finally {
      await db.end();
    }
  });
});

describe("provenance survives whatever packing does to whitespace", () => {
  it("gives every piece a narrow range even with blank runs and padded edges", async () => {
    const { chunk } = await import("../core/chunker.js");
    const big = (c: string) => `${c.repeat(1700)}`;
    // Three-plus newline runs produce EMPTY paragraphs, and an empty paragraph
    // interacting with a hard-wrap flush is what made a piece unfindable by
    // string search — the miss then degraded silently to the whole section.
    write(
      "messy.md",
      `# T\n\n## S\n\n  ${big("a")} \n\n\n\n ${big("b")}\n\n${"z".repeat(9000)}\n\n${big("c")}\n`,
    );
    const snap = walkTree(root, fsProfile);
    const doc = snap.docs[0] as never as { body: string };
    const chunks = chunk(snap.docs[0] as never).filter((c) => c.headingPath.endsWith("S"));
    expect(chunks.length).toBeGreaterThan(2);

    const lines = doc.body.split("\n");
    const sectionSpan =
      Math.max(...chunks.map((c) => c.lineEnd as number)) -
      Math.min(...chunks.map((c) => c.lineStart as number));
    for (const c of chunks) {
      // Narrow: no piece may claim the whole section.
      expect((c.lineEnd as number) - (c.lineStart as number)).toBeLessThan(sectionSpan);
      // Honest: the text really is inside the lines it names.
      const window = lines.slice((c.lineStart as number) - 1, c.lineEnd as number).join("\n");
      expect(window).toContain(c.text.slice(0, 30).trim());
    }
  });
});

describe("a path-only move is carried through the store", () => {
  it("updates the locator and preserves the vector when only the path changed", async () => {
    const { openTestDb } = await import("./helpers/db.js");
    const { upsertDocument } = await import("../store.js");
    const db = await openTestDb();
    try {
      // Explicit id, and a rename WITHIN one directory.
      //
      // A cross-directory move cannot isolate `sourcePath`: `hierarchy` is
      // derived from the directory and is already part of `contentHash`, so the
      // hash would change for that reason alone and the test would pass with
      // sourcePath removed entirely. Same directory, same body, same mtime,
      // same id leaves the path as the ONLY difference.
      write("docs/runbook.md", "---\nid: payments\n---\n# R\n\nstable body");
      // A fixed whole-second timestamp on both: utimesSync does not round-trip
      // sub-millisecond precision, so copying a live mtime leaves the two
      // differing by a fraction and `updatedAt` changes for that reason alone.
      const FIXED = new Date("2026-03-01T00:00:00.000Z");
      utimesSync(join(root, "docs/runbook.md"), FIXED, FIXED);
      const first = walkTree(root, fsProfile).docs[0] as never;
      await upsertDocument(db, first);

      await db.query(
        "INSERT INTO chunk_vectors (tenant, doc_id, seq, ord, embed_model, embedding)" +
          " SELECT tenant, doc_id, seq, 0, 'test-model', ARRAY[0.1,0.2]::float4[] FROM chunks",
      );
      const before = await db.query(
        "SELECT c.source_path, (SELECT count(*)::int FROM chunk_vectors) AS vecs FROM chunks c LIMIT 1",
      );
      expect(before.rows[0].source_path).toBe("docs/runbook.md");
      expect(before.rows[0].vecs).toBeGreaterThan(0);

      // Rename it. Same id, same body, same directory, same mtime.
      //
      // Pinning mtime is what makes this test able to isolate `sourcePath`.
      // Without it the rewritten file gets a fresh mtime, `updatedAt` changes,
      // the content hash differs for that reason alone, and the test passes
      // even with sourcePath removed from the hash entirely — proving nothing
      // about the path-only case it claims to cover.
      unlinkSync(join(root, "docs/runbook.md"));
      write("docs/renamed.md", "---\nid: payments\n---\n# R\n\nstable body");
      utimesSync(join(root, "docs/renamed.md"), FIXED, FIXED);
      const second = walkTree(root, fsProfile).docs[0] as never as { id: string };
      // Precondition: this really is a path-only move — same id, same body — so
      // the document hash gate is the only thing that can notice it.
      expect(second.id).toBe((first as unknown as { id: string }).id);
      // ...and genuinely path-only: same body, same timestamp.
      expect((second as unknown as { updatedAt: string }).updatedAt).toBe(
        (first as unknown as { updatedAt: string }).updatedAt,
      );
      await upsertDocument(db, second as never);

      const after = await db.query(
        "SELECT c.source_path, (SELECT count(*)::int FROM chunk_vectors) AS vecs FROM chunks c LIMIT 1",
      );
      // The locator followed the file...
      expect(after.rows[0].source_path).toBe("docs/renamed.md");
      // ...and identical text did not force a re-embed.
      expect(after.rows[0].vecs).toBe(before.rows[0].vecs);
    } finally {
      await db.end();
    }
  });
});
