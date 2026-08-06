/** Dependency-free path globbing + binary/size gating for repo ingestion. */

export const DEFAULT_REPO_MAX_BYTES = 524288;

/** The one place EIL_REPO_MAX_BYTES is read, so a raw-fetch-time network cap
 *  (BitbucketApiSource.readFile) and the post-fetch content filter below
 *  can't drift onto two different thresholds for the same policy. Fails
 *  SAFE to the default for anything that isn't a finite positive number —
 *  empty, non-numeric, zero, or negative input must not silently disable
 *  every `> maxBytes` guard (NaN in particular makes every such comparison
 *  false, which is exactly "unbounded"). */
export function repoMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EIL_REPO_MAX_BYTES;
  if (raw === undefined) return DEFAULT_REPO_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REPO_MAX_BYTES;
}

/** Supports ** (any chars incl. '/'), * (any run of non-slash), ? (one non-slash). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i += 2;
      if (glob[i] === "/") {
        re += "(?:.*/)?";
        i++;
      } // **/ matches zero or more leading dirs
      else re += ".*";
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

export class RepoFilter {
  private readonly includes: RegExp[];
  private readonly excludes: RegExp[];
  private readonly maxBytes: number;
  constructor(o: { includes?: string[]; excludes?: string[]; maxBytes?: number }) {
    this.includes = (o.includes ?? []).map(globToRegExp);
    this.excludes = (o.excludes ?? []).map(globToRegExp);
    this.maxBytes = o.maxBytes ?? repoMaxBytes();
  }
  acceptPath(path: string): boolean {
    if (this.includes.length > 0 && !this.includes.some((r) => r.test(path))) return false;
    if (this.excludes.some((r) => r.test(path))) return false;
    return true;
  }
  acceptContent(text: string): boolean {
    if (Buffer.byteLength(text, "utf-8") > this.maxBytes) return false;
    return !text.slice(0, 8192).includes("\0");
  }
}
