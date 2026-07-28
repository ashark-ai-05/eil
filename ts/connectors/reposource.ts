/** Pluggable repo content sources for code ingestion. GitCloneSource uses a
 *  treeless partial clone (cheap history + on-demand blobs) for huge repos. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

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
    await this.ensure();
    const out = await this.git([
      "diff",
      "--name-status",
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
