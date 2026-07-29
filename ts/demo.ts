/**
 * Demo preflight.
 *
 * What kills a live demo is discovering at showtime that a PAT expired, a space
 * key is wrong, or the branch is called `master`. Every check here is one that
 * has a plausible failure mode on someone else's org, and each reports what to
 * DO rather than what went wrong.
 *
 * Deliberately read-only: it proves the pieces are reachable and never mutates
 * the catalog, so it is safe to run repeatedly while setting up.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CheckState = "ok" | "warn" | "fail" | "skip";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  /** What to run or change. Absent when nothing is needed. */
  fix?: string;
}

const ok = (name: string, detail: string, fix?: string): Check => ({
  name,
  state: "ok",
  detail,
  ...(fix ? { fix } : {}),
});
const warn = (name: string, detail: string, fix?: string): Check => ({
  name,
  state: "warn",
  detail,
  ...(fix ? { fix } : {}),
});
const fail = (name: string, detail: string, fix?: string): Check => ({
  name,
  state: "fail",
  detail,
  ...(fix ? { fix } : {}),
});
const skip = (name: string, detail: string): Check => ({ name, state: "skip", detail });

/** Backend: PGlite needs nothing installed; anything else needs a reachable server. */
export function checkBackend(): Check {
  const url = process.env.EIL_DATABASE_URL ?? "";
  if (url.startsWith("pglite://")) {
    return ok("backend", `PGlite at ${url.slice("pglite://".length)} — no server, no admin rights`);
  }
  if (!url) {
    return warn(
      "backend",
      "EIL_DATABASE_URL unset; will try a local Postgres",
      "export EIL_DATABASE_URL=pglite://.eil-demo   # zero-install, no Docker",
    );
  }
  return warn("backend", `${url.split("@").pop()} — needs a reachable server`);
}

/** The local embedding model must be present, or the vector arm silently never runs. */
export async function checkEmbedder(): Promise<Check> {
  try {
    const { getEmbedder } = await import("./embed/index.js");
    const emb = getEmbedder();
    const [v] = await emb.embed(["preflight"]);
    if (!v || v.length === 0) return fail("embedder", "produced an empty vector");
    return ok("embedder", `${emb.id}, ${v.length} dims, ${emb.windowChars} char window`);
  } catch (err: any) {
    return fail(
      "embedder",
      err.message.split("\n")[0],
      "pnpm add @huggingface/transformers   # optional dep, vendored model",
    );
  }
}

/**
 * Reach a connector with the configured credentials.
 *
 * Distinguishes "not configured" from "configured and broken" — the second is
 * the one that ruins a demo, and an unconfigured source is a legitimate choice.
 */
export async function checkConnector(kind: "confluence" | "jira"): Promise<Check> {
  const prefix = kind.toUpperCase();
  if (!process.env[`EIL_${prefix}_URL`]) {
    return skip(kind, `EIL_${prefix}_URL unset — this source will be skipped`);
  }
  try {
    if (kind === "confluence") {
      const { ConfluenceClient } = await import("./connectors/confluence.js");
      const c = new ConfluenceClient();
      // One page is enough to prove URL + token + permissions all work.
      const probe = await c.listIds();
      return ok(kind, `reachable, ${probe.length} pages visible to this token`);
    }
    const { JiraClient } = await import("./connectors/jira.js");
    const j = new JiraClient();
    const probe = await j.listIds();
    return ok(kind, `reachable, ${probe.length} issues visible to this token`);
  } catch (err: any) {
    const msg = String(err.message).split("\n")[0] ?? "unreachable";
    const auth = /401|403/.test(msg);
    return fail(
      kind,
      msg,
      auth
        ? `eil auth login ${kind}   # the token is rejected, not missing`
        : `check EIL_${prefix}_URL is the base URL (no /wiki, no trailing path)`,
    );
  }
}

/**
 * A local repo, and the branch it actually has.
 *
 * `--branch main` is the default and plenty of repos are still `master`; the
 * clone then fails with a raw git error. Reading the real HEAD up front turns
 * that into a flag you already know to pass.
 */
export async function checkRepo(path: string): Promise<Check> {
  if (!existsSync(path)) return fail("repo", `${path} does not exist`);
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      path,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const branch = stdout.trim();
    const { stdout: n } = await execFileAsync("git", ["-C", path, "ls-files"]);
    const files = n.split("\n").filter(Boolean).length;
    return ok("repo", `${path} on '${branch}', ${files} tracked files`, `--branch ${branch}`);
  } catch (err: any) {
    return fail("repo", `not a git repository: ${String(err.message).split("\n")[0]}`);
  }
}

/**
 * A stale clone cache makes `git clone` fail with a raw error and no recovery —
 * hit while rehearsing, so it is a check rather than a footnote.
 */
export function checkCloneCache(dir = ".eil-repos"): Check {
  if (!existsSync(dir)) return ok("clone cache", "clean");
  return warn(
    "clone cache",
    `${dir} exists; git clone into a non-empty directory fails`,
    `rm -rf ${dir}`,
  );
}

export async function preflight(opts: { repo?: string } = {}): Promise<Check[]> {
  const checks: Check[] = [checkBackend(), checkCloneCache()];
  checks.push(await checkEmbedder());
  checks.push(await checkConnector("confluence"));
  checks.push(await checkConnector("jira"));
  if (opts.repo) checks.push(await checkRepo(opts.repo));
  return checks;
}

export const worstState = (checks: Check[]): CheckState =>
  checks.some((c) => c.state === "fail")
    ? "fail"
    : checks.some((c) => c.state === "warn")
      ? "warn"
      : "ok";
