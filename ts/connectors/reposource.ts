/** Pluggable repo content sources for code ingestion. GitCloneSource uses a
 *  treeless partial clone (cheap history + on-demand blobs) for huge repos. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type DcClient, type Fetcher, getJson, makeClient } from "./auth.js";

const run = promisify(execFile);

export interface RepoChange {
  path: string;
  status: "A" | "M" | "D";
}
export interface RepoSource {
  headSha(): Promise<string>;
  listFiles(): AsyncGenerator<string>;
  changedSince(sha: string): AsyncGenerator<RepoChange>;
  readFile(path: string): Promise<string>;
  blobUrl(path: string): string | null;
  dispose(): Promise<void>;
}

export class GitCloneSource implements RepoSource {
  private readonly ref: string;
  private readonly branch: string;
  private readonly subpath?: string;
  private readonly dir: string;
  private ready: Promise<void> | null = null;
  constructor(cfg: { ref: string; branch?: string; subpath?: string; cacheDir?: string }) {
    GitCloneSource.assertNoArgvInjection("ref", cfg.ref);
    if (cfg.branch !== undefined) GitCloneSource.assertNoArgvInjection("branch", cfg.branch);
    if (cfg.subpath !== undefined) GitCloneSource.assertNoArgvInjection("subpath", cfg.subpath);
    this.ref = cfg.ref;
    this.branch = cfg.branch ?? "main";
    if (cfg.subpath) this.subpath = cfg.subpath;
    if (cfg.cacheDir) {
      this.dir = cfg.cacheDir;
    } else {
      const base = process.env.EIL_REPO_CACHE ?? ".eil-repos";
      this.dir = join(base, this.ref.replace(/[^\w.-]+/g, "_"));
    }
  }
  /** Refuse values that could be interpreted by git as a flag instead of a
   *  positional operand (argv flag-smuggling / argument injection guard). */
  private static assertNoArgvInjection(field: string, value: string): void {
    if (value.startsWith("-")) {
      throw new Error(
        `refusing repo ref/branch/subpath starting with '-' (argv-injection guard): ${field}=${value}`,
      );
    }
  }
  private async git(args: string[]): Promise<string> {
    const { stdout } = await run("git", ["-C", this.dir, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }
  private async ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        if (!existsSync(join(this.dir, ".git"))) {
          await run(
            "git",
            [
              "clone",
              "--filter=blob:none",
              "--single-branch",
              "--branch",
              this.branch,
              "--end-of-options",
              this.ref,
              this.dir,
            ],
            { maxBuffer: 64 * 1024 * 1024 },
          );
        } else {
          await this.git(["fetch", "--quiet", "origin", this.branch]);
          await this.git(["reset", "--quiet", "--hard", `origin/${this.branch}`]);
        }
      })();
    }
    return this.ready;
  }
  async headSha(): Promise<string> {
    await this.ensure();
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }
  async *listFiles(): AsyncGenerator<string> {
    await this.ensure();
    const out = await this.git(["ls-files", ...(this.subpath ? ["--", this.subpath] : [])]);
    for (const line of out.split("\n")) if (line) yield line;
  }
  async *changedSince(sha: string): AsyncGenerator<RepoChange> {
    GitCloneSource.assertNoArgvInjection("sha", sha);
    await this.ensure();
    const out = await this.git([
      "diff",
      "--name-status",
      "--end-of-options",
      sha,
      "HEAD",
      ...(this.subpath ? ["--", this.subpath] : []),
    ]);
    for (const line of out.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      const code = parts[0]![0]!;
      if ((code === "R" || code === "C") && parts.length >= 3) {
        yield { path: parts[1]!, status: "D" };
        yield { path: parts[2]!, status: "A" };
      } else if (code === "A" || code === "M" || code === "D") {
        yield { path: parts[1]!, status: code };
      }
    }
  }
  async readFile(path: string): Promise<string> {
    await this.ensure();
    return this.git(["show", `HEAD:${path}`]);
  }
  blobUrl(path: string): string | null {
    const m = this.ref.replace(/\.git$/, "").match(/^https?:\/\/[^/]+\/(.+)$/);
    return m ? `${this.ref.replace(/\.git$/, "")}/browse/${path}?at=${this.branch}` : null;
  }
  async dispose(): Promise<void> {} // persistent cache
}

/** Percent-encode a slash-joined path per-segment, so a segment containing
 *  '?', '#', or a space doesn't corrupt the URL — without encoding the '/'
 *  separators themselves. */
const enc = (s: string): string => s.split("/").map(encodeURIComponent).join("/");

export class BitbucketApiSource implements RepoSource {
  private readonly client: DcClient;
  private readonly project: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly subpath: string;
  private head: string | null = null;
  constructor(
    cfg: { ref: string; branch?: string; subpath?: string; baseUrl?: string; token?: string },
    fetcher?: Fetcher,
  ) {
    const [project, repo] = cfg.ref.split("/");
    this.project = project!;
    this.repo = repo!;
    this.branch = cfg.branch ?? "main";
    this.subpath = cfg.subpath ?? "";
    this.client = makeClient("BITBUCKET", cfg.baseUrl, cfg.token, fetcher);
  }
  private base(): string {
    return `/rest/api/1.0/projects/${enc(this.project)}/repos/${enc(this.repo)}`;
  }
  async headSha(): Promise<string> {
    const d = await getJson(this.client, `${this.base()}/commits`, {
      until: this.branch,
      limit: 1,
    });
    this.head = d.values?.[0]?.id ?? "";
    return this.head!;
  }
  async *listFiles(): AsyncGenerator<string> {
    const at = this.head ?? (await this.headSha());
    let start = 0;
    for (;;) {
      const d = await getJson(this.client, `${this.base()}/files/${enc(this.subpath)}`, {
        at,
        start,
        limit: 1000,
      });
      for (const p of d.values ?? [])
        yield this.subpath ? `${this.subpath.replace(/\/$/, "")}/${p}` : p;
      if (d.isLastPage !== false) return;
      start = d.nextPageStart ?? start + (d.values?.length ?? 0);
    }
  }
  async *changedSince(sha: string): AsyncGenerator<RepoChange> {
    const to = this.head ?? (await this.headSha());
    const map: Record<string, "A" | "M" | "D"> = {
      ADD: "A",
      MODIFY: "M",
      DELETE: "D",
      COPY: "A",
      MOVE: "M",
    };
    // Match how listFiles scopes to subpath: only yield changes under it.
    const sub = this.subpath.replace(/\/$/, "");
    let start = 0;
    for (;;) {
      const d = await getJson(this.client, `${this.base()}/compare/changes`, {
        from: sha,
        to,
        start,
        limit: 1000,
      });
      for (const c of d.values ?? []) {
        const p = typeof c.path === "string" ? c.path : c.path?.toString;
        const st = map[c.type as string];
        if (!p || !st) continue;
        if (!sub || p === sub || p.startsWith(`${sub}/`)) yield { path: p, status: st };
      }
      if (d.isLastPage !== false) return;
      start = d.nextPageStart ?? start + (d.values?.length ?? 0);
    }
  }
  async readFile(path: string): Promise<string> {
    const at = this.head ?? (await this.headSha());
    const res = await this.client.fetcher(
      new URL(`${this.client.baseUrl}${this.base()}/raw/${enc(path)}?at=${at}`),
      { headers: this.client.headers },
    );
    if (!res.ok) throw new Error(`raw ${path} -> ${res.status}`);
    return res.text();
  }
  blobUrl(path: string): string | null {
    return `${this.client.baseUrl}${this.base()}/browse/${enc(path)}?at=${this.branch}`;
  }
  async dispose(): Promise<void> {}
}
