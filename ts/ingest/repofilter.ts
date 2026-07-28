/** Dependency-free path globbing + binary/size gating for repo ingestion. */

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
    this.maxBytes = o.maxBytes ?? Number(process.env.EIL_REPO_MAX_BYTES ?? 524288);
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
