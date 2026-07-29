/**
 * Confluence normalizer. Fixture dicts and the live connector produce the
 * same page shape; this mapping is the contract either way.
 */

import { CanonicalDoc } from "../contracts/models.js";
import { extractLinks } from "./common.js";

export interface ConfluencePage {
  id: string;
  title: string;
  url?: string | null;
  author?: string | null;
  created?: string | null;
  updated?: string | null;
  ancestors?: string[];
  acl_groups?: string[];
  labels?: string[];
  body: string;
}

export function normalize(page: ConfluencePage, tenant = "default"): CanonicalDoc {
  const docId = `confluence:page:${page.id}`;
  return CanonicalDoc.parse({
    id: docId,
    tenant,
    source: "confluence",
    title: page.title,
    url: page.url ?? null,
    author: page.author ?? null,
    createdAt: page.created ?? null,
    updatedAt: page.updated ?? null,
    hierarchy: page.ancestors ?? [],
    aclGroups: page.acl_groups ?? [],
    qualityTier: "authored",
    body: page.labels?.length ? `**Labels:** ${page.labels.join(", ")}\n\n${page.body}` : page.body,
    links: extractLinks(page.body, docId),
  });
}
