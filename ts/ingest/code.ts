import { existsSync } from "node:fs";
/** Map a repo file into a CanonicalDoc (source="code"), plus ref helpers. */
import { detectLanguage, EXTRACTOR_VERSION } from "./codeindex.js";
import type { CanonicalDoc } from "../contracts/models.js";

export function normalizeCode(
  key: string,
  path: string,
  content: string,
  url: string | null,
  tenant: string,
  ref?: string,
): CanonicalDoc {
  const dirs = path.split("/").slice(0, -1);
  return {
    id: `code:${key}:${path}`,
    tenant,
    source: "code",
    title: path,
    url: url ?? undefined,
    hierarchy: [key, ...dirs],
    aclGroups: [],
    qualityTier: "authored",
    body: content,
    links: [],
    codeRepo: key,
    codePath: path,
    ...(ref ? { codeRef: ref } : {}),
    ...(detectLanguage(path) ? { codeLanguage: detectLanguage(path)! } : {}),
    codeExtractorVersion: EXTRACTOR_VERSION,
  };
}

/** org/repo (or PROJECT/repo) from a ref; local path -> basename; override wins. */
export function repoKey(ref: string, override?: string): string {
  if (override) return override;
  let s = ref.replace(/\.git$/, "");
  if (s.includes("://")) {
    const parts = s.split("://")[1]!.split("/").filter(Boolean).slice(1); // drop host
    return parts.slice(-2).join("/") || parts.join("/");
  }
  if (s.startsWith("git@")) {
    s = s.split(":")[1] ?? s; // git@host:org/repo
    return s.split("/").slice(-2).join("/");
  }
  return s.replace(/\/+$/, "").split("/").pop() ?? s; // local path
}

export function detectSource(ref: string): "git" | "bitbucket" {
  if (ref.includes("://") || ref.startsWith("git@") || existsSync(ref)) return "git";
  if (/^[^/]+\/[^/]+$/.test(ref)) return "bitbucket";
  return "git";
}
