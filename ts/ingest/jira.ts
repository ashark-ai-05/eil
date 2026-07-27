/**
 * Jira normalizer. Issue = one document: summary as title, description +
 * comments as body sections.
 */

import { CanonicalDoc } from "../contracts/models.js";
import { extractLinks } from "./common.js";

export interface JiraIssue {
  key: string;
  url?: string | null;
  fields: {
    summary: string;
    status?: string | null;
    issuetype?: string | null;
    project?: string | null;
    reporter?: string | null;
    created?: string | null;
    updated?: string | null;
    description?: string | null;
    comments?: Array<{ author?: string; body: string }>;
    acl_groups?: string[];
  };
}

export function normalize(issue: JiraIssue, tenant = "default"): CanonicalDoc {
  const key = issue.key;
  const docId = `jira:issue:${key}`;
  const f = issue.fields;

  const parts = [
    `**Status:** ${f.status ?? "Unknown"} · **Type:** ${f.issuetype ?? "Unknown"}`,
  ];
  if (f.description) parts.push(`## Description\n\n${f.description}`);
  for (const c of f.comments ?? []) {
    parts.push(`## Comment — ${c.author ?? "unknown"}\n\n${c.body}`);
  }
  const body = parts.join("\n\n");

  return CanonicalDoc.parse({
    id: docId,
    tenant,
    source: "jira",
    title: `${key}: ${f.summary}`,
    url: issue.url ?? null,
    author: f.reporter ?? null,
    createdAt: f.created ?? null,
    updatedAt: f.updated ?? null,
    hierarchy: [f.project ?? key.split("-")[0]!],
    aclGroups: f.acl_groups ?? [],
    qualityTier: "authored",
    body,
    links: extractLinks(body, docId),
  });
}
