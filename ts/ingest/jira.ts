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
    /**
     * `visibility` is Jira's own role/group restriction on a single comment —
     * independent of the issue's ACL. EIL has no per-comment ACL model yet, so
     * a restricted comment cannot inherit the issue-level `acl_groups` without
     * over-exposing it to anyone who can see the issue.
     */
    comments?: Array<{
      author?: string;
      body: string;
      visibility?: { type: string; value: string } | null;
    }>;
    acl_groups?: string[];
    assignee?: string | null;
    labels?: string[];
    priority?: string | null;
    resolution?: string | null;
    components?: string[];
    fix_versions?: string[];
    parent?: string | null;
    /** Jira's own dependency graph: {type: "blocks", key: "PAY-42"} */
    issue_links?: Array<{ type: string; key: string }>;
  };
}

export function normalize(issue: JiraIssue, tenant = "default"): CanonicalDoc {
  const key = issue.key;
  const docId = `jira:issue:${key}`;
  const f = issue.fields;

  // visibility-restricted comments are fail-closed: excluded from the shared
  // body rather than inheriting the (broader) issue-level acl_groups, since
  // there is no per-comment ACL model yet. Only the count is surfaced — never
  // the restricted author or text — so operators can see omission happened
  // without the omission signal itself leaking anything.
  const allComments = f.comments ?? [];
  const visibleComments = allComments.filter((c) => !c.visibility);
  const restrictedCount = allComments.length - visibleComments.length;

  // Facets go in the body as well as the fields, because the lexical arm can
  // only match what is in the text — a query for "unresolved payments bug
  // assigned to alice" has nowhere else to hit.
  const facets = [
    `**Status:** ${f.status ?? "Unknown"}`,
    `**Type:** ${f.issuetype ?? "Unknown"}`,
    ...(f.priority ? [`**Priority:** ${f.priority}`] : []),
    ...(f.assignee ? [`**Assignee:** ${f.assignee}`] : []),
    ...(f.resolution ? [`**Resolution:** ${f.resolution}`] : []),
    ...(f.components?.length ? [`**Components:** ${f.components.join(", ")}`] : []),
    ...(f.fix_versions?.length ? [`**Fix versions:** ${f.fix_versions.join(", ")}`] : []),
    ...(f.labels?.length ? [`**Labels:** ${f.labels.join(", ")}`] : []),
    ...(restrictedCount > 0
      ? [
          `**Restricted comments omitted:** ${restrictedCount} (visibility-limited; not yet ACL-mirrored)`,
        ]
      : []),
  ];
  const parts = [facets.join(" · ")];
  if (f.description) parts.push(`## Description\n\n${f.description}`);
  for (const c of visibleComments) {
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
    // Structured edges FIRST, then whatever the prose scraper finds. Jira's own
    // issuelinks are typed and exact; a regex over the description is a guess.
    // Deduped across both, so an issue that is both linked and named in the
    // description — the common case — contributes one edge and not two.
    links: [
      ...new Set([
        ...(f.parent ? [`jira:issue:${f.parent}`] : []),
        ...(f.issue_links ?? []).map((l) => `jira:issue:${l.key}`),
        ...extractLinks(body, docId),
      ]),
    ].filter((l) => l !== docId),
  });
}
