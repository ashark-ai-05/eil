import { existsSync } from "node:fs";
import type { CanonicalDoc } from "../contracts/models.js";
import { ticketKeys } from "../core/ticket.js";
/** Map a repo file into a CanonicalDoc (source="code"), plus ref helpers. */
import { EXTRACTOR_VERSION, detectLanguage } from "./codeindex.js";

const IMPORT_RE =
  /\bimport\s+(?:.+?\s+from\s+)?["']([^"']+)["']|\brequire\(["']([^"']+)["']\)|\bfrom\s+([\w.]+)\s+import\b/g;

/**
 * Relative imports resolved against the importing file, so `./retry` inside
 * `src/pay/charge.ts` becomes `code:<repo>:src/pay/retry`. Extensionless, because
 * the target may be .ts/.tsx/.js — a dangling edge is acceptable (expand()
 * already renders unresolvable destinations as ingested:false) and is far more
 * useful than no edge at all. Bare specifiers are package names, not documents
 * in this catalog, so they are skipped.
 */
function importLinks(key: string, path: string, content: string): string[] {
  const dir = path.split("/").slice(0, -1);
  const out: string[] = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || !spec.startsWith(".")) continue;
    const parts = [...dir];
    for (const seg of spec.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    const resolved = parts.join("/").replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
    if (resolved) out.push(`code:${key}:${resolved}`);
  }
  return out;
}

export function normalizeCode(
  key: string,
  path: string,
  content: string,
  url: string | null,
  tenant: string,
  ref?: string,
  updatedAt?: string | null,
): CanonicalDoc {
  const dirs = path.split("/").slice(0, -1);
  const selfId = `code:${key}:${path}`;
  const selfIdNoExt = `code:${key}:${path.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "")}`;
  return {
    id: selfId,
    tenant,
    source: "code",
    title: path,
    url: url ?? undefined,
    hierarchy: [key, ...dirs],
    aclGroups: [],
    qualityTier: "authored",
    body: content,
    // A null updated_at is NOT neutral: ranking.modifier() returns
    // prior * RECENCY_FLOOR for unknown age, so every code document carried a
    // permanent 40% penalty against every prose document — which silently
    // cancelled the router's code-arm weighting on exactly the symbol and path
    // queries that arm exists to serve.
    ...(updatedAt ? { updatedAt } : {}),
    // Ticket keys are where the code<->Jira edge physically lives, and imports
    // are a free, high-precision code<->code edge. `links: []` threw both away.
    links: [
      ...ticketKeys(content).map((k) => `jira:issue:${k}`),
      ...importLinks(key, path, content),
      // Compare against the EXTENSION-STRIPPED self id too: importLinks strips
      // extensions when resolving (the target may be .ts/.tsx/.js), so a file
      // importing itself produced `code:<repo>:src/a` against a self id of
      // `code:<repo>:src/a.ts` and slipped through.
    ].filter((l) => l !== selfId && l !== selfIdNoExt),
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
