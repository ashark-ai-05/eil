import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Fetcher } from "../connectors/auth.js";
import { BitbucketApiSource, GitCloneSource } from "../connectors/reposource.js";
import type { RepoChange, RepoSource } from "../connectors/reposource.js";
import { chunk } from "../core/chunker.js";
import { detectSource, normalizeCode, repoKey } from "../ingest/code.js";
import { RepoFilter, globToRegExp } from "../ingest/repofilter.js";

const codeDoc = (body: string) =>
  ({
    id: "code:r:a.ts",
    tenant: "default",
    source: "code",
    title: "src/a.ts",
    hierarchy: ["r", "src"],
    aclGroups: [],
    qualityTier: "authored",
    body,
    links: [],
  }) as any;

describe("code chunker", () => {
  it("windows code by lines with L-range headings", () => {
    const body = Array.from({ length: 130 }, (_, i) => `line${i + 1}`).join("\n");
    const chunks = chunk(codeDoc(body));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.headingPath).toBe("src/a.ts › L1-60");
    expect(chunks[0]!.text.startsWith("src/a.ts › L1-60\n\n")).toBe(true);
    expect(chunks[0]!.text).toContain("line1");
    // overlap: window 2 starts before window 1 ends (60 - 10 = 51)
    expect(chunks[1]!.headingPath).toBe("src/a.ts › L51-110");
    // deterministic
    expect(chunk(codeDoc(body))).toEqual(chunks);
  });
  it("leaves the prose path unchanged for non-code docs", () => {
    const prose = {
      id: "x",
      tenant: "default",
      source: "jira",
      title: "T",
      hierarchy: [],
      aclGroups: [],
      qualityTier: "authored",
      body: "## H\n\nsome text",
      links: [],
    } as any;
    const chunks = chunk(prose);
    expect(chunks[0]!.headingPath).toContain("T"); // section breadcrumb, not L-range
    expect(chunks[0]!.headingPath).not.toMatch(/› L\d/);
  });
});

describe("repofilter", () => {
  it("globs with **, *, ?", () => {
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a/b/c.js")).toBe(false);
    expect(globToRegExp("**/vendor/**").test("x/vendor/y/z.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false); // * doesn't cross /
  });
  it("acceptPath honors includes then excludes", () => {
    const f = new RepoFilter({ includes: ["**/*.ts"], excludes: ["**/generated/**"] });
    expect(f.acceptPath("src/a.ts")).toBe(true);
    expect(f.acceptPath("src/a.js")).toBe(false); // not included
    expect(f.acceptPath("src/generated/a.ts")).toBe(false); // excluded
  });
  it("no includes = accept all except excludes", () => {
    const f = new RepoFilter({ excludes: ["**/*.lock"] });
    expect(f.acceptPath("a/b.ts")).toBe(true);
    expect(f.acceptPath("a/b.lock")).toBe(false);
  });
  it("acceptContent rejects binary and oversize", () => {
    const f = new RepoFilter({ maxBytes: 100 });
    expect(f.acceptContent("clean text")).toBe(true);
    expect(f.acceptContent("has\0nul")).toBe(false); // binary
    expect(f.acceptContent("x".repeat(101))).toBe(false); // oversize
  });
});

describe("code doc model", () => {
  it("normalizeCode builds a code CanonicalDoc", () => {
    const d = normalizeCode(
      "org/repo",
      "src/pay/retry.ts",
      "const x=1\n",
      "https://h/browse/src/pay/retry.ts",
      "default",
    );
    expect(d.id).toBe("code:org/repo:src/pay/retry.ts");
    expect(d.source).toBe("code");
    expect(d.title).toBe("src/pay/retry.ts");
    expect(d.hierarchy).toEqual(["org/repo", "src", "pay"]);
    expect(d.aclGroups).toEqual([]);
    expect(d.url).toBe("https://h/browse/src/pay/retry.ts");
    expect(d.body).toBe("const x=1\n");
  });
  it("repoKey derives org/repo, honors override, strips .git", () => {
    expect(repoKey("https://bb.corp/scm/PAY/retry.git")).toBe("PAY/retry");
    expect(repoKey("git@github.com:org/repo.git")).toBe("org/repo");
    expect(repoKey("/home/me/work/myrepo")).toBe("myrepo");
    expect(repoKey("anything", "custom")).toBe("custom");
  });
  it("detectSource routes by ref shape", () => {
    expect(detectSource("https://bb/scm/x/y.git")).toBe("git");
    expect(detectSource("git@github.com:o/r.git")).toBe("git");
    expect(detectSource("PAY/retry")).toBe("bitbucket");
  });
});

describe("GitCloneSource (real git)", () => {
  const root = mkdtempSync(join(tmpdir(), "eil-git-"));
  const origin = join(root, "origin");
  const cache = join(root, "cache");
  const g = (args: string[]) => execFileSync("git", ["-C", origin, ...args], { encoding: "utf-8" });
  let c1 = "";
  beforeAll(() => {
    mkdirSync(join(origin, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    writeFileSync(join(origin, "src/a.ts"), "l1\nl2\n");
    writeFileSync(join(origin, "src/b.ts"), "keep\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "c1"]);
    c1 = g(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(origin, "src/a.ts"), "l1\nl2\nl3\n");
    rmSync(join(origin, "src/b.ts"));
    writeFileSync(join(origin, "src/c.ts"), "new\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "c2"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("clones, lists, reads, and diffs A/M/D", async () => {
    const src = new GitCloneSource({ ref: origin, branch: "main", cacheDir: cache });
    const head = await src.headSha();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const files: string[] = [];
    for await (const p of src.listFiles()) files.push(p);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/c.ts");
    expect(files).not.toContain("src/b.ts"); // deleted at head
    expect(await src.readFile("src/a.ts")).toBe("l1\nl2\nl3\n");
    const changes: Record<string, string> = {};
    for await (const ch of src.changedSince(c1)) changes[ch.path] = ch.status;
    expect(changes["src/a.ts"]).toBe("M");
    expect(changes["src/b.ts"]).toBe("D");
    expect(changes["src/c.ts"]).toBe("A");
    await src.dispose();
  });

  it("rejects ref/branch/subpath starting with '-' (argv-injection guard)", () => {
    const guardCache = join(root, "guard-cache");
    expect(
      () => new GitCloneSource({ ref: "--upload-pack=x", branch: "main", cacheDir: guardCache }),
    ).toThrow(/argv-injection|starting with '-'/);
    expect(() => new GitCloneSource({ ref: origin, branch: "-x", cacheDir: guardCache })).toThrow(
      /argv-injection|starting with '-'/,
    );
    expect(
      () =>
        new GitCloneSource({ ref: origin, branch: "main", subpath: "--foo", cacheDir: guardCache }),
    ).toThrow(/argv-injection|starting with '-'/);
  });
});

const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("BitbucketApiSource (mock)", () => {
  it("resolves head, lists, diffs, reads, and links", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/commits")) return json({ values: [{ id: "abc123" }] });
      if (u.includes("/files")) return json({ values: ["src/a.ts", "src/b.ts"], isLastPage: true });
      if (u.includes("/compare/changes"))
        return json({
          values: [
            { path: { toString: "src/a.ts" }, type: "MODIFY" },
            { path: { toString: "src/b.ts" }, type: "DELETE" },
          ],
          isLastPage: true,
        });
      if (u.includes("/raw/")) return new Response("file contents", { status: 200 });
      return json({});
    };
    const s = new BitbucketApiSource(
      { ref: "PAY/retry", branch: "main", baseUrl: "http://localhost:7990", token: "fake-token" },
      fetcher,
    );
    expect(await s.headSha()).toBe("abc123");
    const files = [];
    for await (const p of s.listFiles()) files.push(p);
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    const changes: Record<string, string> = {};
    for await (const ch of s.changedSince("old")) changes[ch.path] = ch.status;
    expect(changes).toEqual({ "src/a.ts": "M", "src/b.ts": "D" });
    expect(await s.readFile("src/a.ts")).toBe("file contents");
    expect(s.blobUrl("src/a.ts")).toContain("/projects/PAY/repos/retry/browse/src/a.ts");
  });

  it("changedSince filters out-of-subpath changes, matching listFiles scoping", async () => {
    const fetcher: Fetcher = async (url) => {
      const u = String(url);
      if (u.includes("/commits")) return json({ values: [{ id: "abc123" }] });
      if (u.includes("/compare/changes"))
        return json({
          values: [
            { path: { toString: "apps/web/src/a.ts" }, type: "MODIFY" },
            { path: { toString: "apps/api/src/b.ts" }, type: "MODIFY" },
            { path: { toString: "apps/web-extra/c.ts" }, type: "ADD" }, // prefix but not a subpath boundary
          ],
          isLastPage: true,
        });
      return json({});
    };
    const s = new BitbucketApiSource(
      {
        ref: "PAY/retry",
        branch: "main",
        subpath: "apps/web",
        baseUrl: "http://localhost:7990",
        token: "fake-token",
      },
      fetcher,
    );
    const changes: Record<string, string> = {};
    for await (const ch of s.changedSince("old")) changes[ch.path] = ch.status;
    expect(changes).toEqual({ "apps/web/src/a.ts": "M" });
    expect(changes["apps/api/src/b.ts"]).toBeUndefined();
    expect(changes["apps/web-extra/c.ts"]).toBeUndefined();
  });
});

describe("ingestRepo orchestration", () => {
  const dir = mkdtempSync(join(tmpdir(), "eil-repo-"));
  beforeAll(async () => {
    process.env.EIL_DATABASE_URL = `pglite://${dir}`;
    const { connect, migrate } = await import("../db.js");
    const c = await connect();
    await migrate(c);
    await c.end();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function fakeSource(
    head: string,
    files: Record<string, string>,
    changes?: RepoChange[],
  ): RepoSource {
    return {
      headSha: async () => head,
      async *listFiles() {
        for (const p of Object.keys(files)) yield p;
      },
      async *changedSince(_sha: string) {
        for (const ch of changes ?? []) yield ch;
      },
      readFile: async (p: string) => files[p] ?? "",
      blobUrl: () => null,
      dispose: async () => {},
    };
  }

  it("full ingest sets the per-repo cursor and upserts code docs; incremental applies A/M/D", async () => {
    const { ingestRepo } = await import("../ingest/pipeline.js");
    const { RepoFilter } = await import("../ingest/repofilter.js");
    const { connect } = await import("../db.js");
    const { getCursor } = await import("../store.js");
    const filter = new RepoFilter({ includes: ["**/*.ts"] });

    const full = await ingestRepo(
      fakeSource("sha1", {
        "src/a.ts": "l1\n",
        "src/skip.md": "x",
        "src/big.ts": "\0",
      }),
      "org/repo",
      undefined,
      filter,
      "default",
    );
    expect(full.upserted).toBe(1); // a.ts; skip.md not-included; big.ts binary
    expect(full.skipped).toBeGreaterThanOrEqual(2);
    const c = await connect();
    try {
      expect(await getCursor(c, "code:org/repo")).toBe("sha1");
      const doc = await c.query("SELECT source FROM documents WHERE id = 'code:org/repo:src/a.ts'");
      expect(doc.rows[0].source).toBe("code");

      const inc = await ingestRepo(
        fakeSource("sha2", { "src/a.ts": "l1\nl2\n", "src/new.ts": "n\n" }, [
          { path: "src/a.ts", status: "M" },
          { path: "src/new.ts", status: "A" },
          { path: "src/a.ts", status: "D" },
        ]),
        "org/repo",
        undefined,
        filter,
        "default",
      );
      // note: contrived changes include a D for a.ts last -> ends deleted
      // Need a fresh connection to see the updated cursor
      const c2 = await connect();
      try {
        expect(await getCursor(c2, "code:org/repo")).toBe("sha2");
        // The tombstone for src/a.ts must actually remove the row, not just
        // increment the counter (tombstone() bumps out.deleted unconditionally
        // even on a no-op/wrong-id delete, so check the DB directly).
        const gone = await c2.query(
          "SELECT 1 FROM documents WHERE id = 'code:org/repo:src/a.ts' AND tenant = 'default'",
        );
        expect(gone.rows.length).toBe(0);
      } finally {
        await c2.end();
      }
      // Verify at least one upsert and one delete occurred in incremental
      expect(inc.upserted).toBeGreaterThan(0);
      expect(inc.deleted).toBeGreaterThan(0);
    } finally {
      await c.end();
    }
  });
});
