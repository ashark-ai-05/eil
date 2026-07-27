/**
 * Obsidian vault connector — the curation layer. Everything is
 * quality_tier=curated; [[wikilinks]] feed the link graph; vault PRs are the
 * write-back target that makes the corpus compound.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CanonicalDoc } from "../contracts/models.js";
import { extractLinks } from "./common.js";

export function noteId(vaultRoot: string, path: string): string {
  const rel = relative(vaultRoot, path).replace(/\.md$/, "");
  return `obsidian:note:${rel.split(sep).join("/")}`;
}

export function normalizeNote(vaultRoot: string, path: string, tenant = "default"): CanonicalDoc {
  const body = readFileSync(path, "utf-8");
  const docId = noteId(vaultRoot, path);
  const relParts = relative(vaultRoot, path).split(sep);
  let title = relParts[relParts.length - 1]!.replace(/\.md$/, "");
  for (const line of body.split("\n")) {
    if (line.startsWith("# ")) {
      title = line.slice(2).trim();
      break;
    }
  }
  return CanonicalDoc.parse({
    id: docId,
    tenant,
    source: "obsidian",
    title,
    updatedAt: new Date(statSync(path).mtimeMs).toISOString(),
    hierarchy: relParts.slice(0, -1),
    aclGroups: [],
    qualityTier: "curated",
    body,
    links: extractLinks(body, docId),
  });
}

export function walkVault(vaultRoot: string, tenant = "default"): CanonicalDoc[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".obsidian" || entry.name === ".trash") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(vaultRoot);
  files.sort();
  return files.map((p) => normalizeNote(vaultRoot, p, tenant));
}
