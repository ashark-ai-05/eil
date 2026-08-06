/**
 * Live Jira DC connector: cursor-based JQL incremental sync. Output feeds
 * ingest/jira.normalize unchanged. Descriptions are wiki markup — close
 * enough for FTS.
 */

import type { JiraIssue } from "../ingest/jira.js";
import { type DcClient, type Fetcher, getJson, makeClient } from "./auth.js";
import { cqlTs } from "./confluence.js";
import { stableListing } from "./stable-pages.js";

export const PAGE_SIZE = 50;

/** Cheapest read-only "does this token work" call — never depends on any
 *  project/issue existing or being visible to it. Used only by `eil doctor`. */
export async function doctorProbe(client: DcClient): Promise<void> {
  await getJson(client, "/rest/api/2/myself");
}
// issuelinks is the point of this list. EIL was regex-scraping ticket keys out
// of prose while Jira's OWN structured dependency graph — blocks, is-blocked-by,
// duplicates, relates-to — sat one field away and was never requested. assignee,
// labels, resolution and priority are the facets an SDLC agent filters on, and
// parent ties a subtask to its epic.
const FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "project",
  "reporter",
  "created",
  "updated",
  "comment",
  "assignee",
  "labels",
  "priority",
  "resolution",
  "resolutiondate",
  "components",
  "fixVersions",
  "parent",
  "issuelinks",
].join(",");

export class JiraClient {
  readonly client: DcClient;

  constructor(baseUrl?: string, token?: string, fetcher?: Fetcher) {
    this.client = makeClient("JIRA", baseUrl, token, fetcher);
  }

  async *updatedSince(cursor: string | null, scope?: string): AsyncGenerator<JiraIssue> {
    const clauses: string[] = [];
    if (scope) clauses.push(scope);
    if (cursor) clauses.push(`updated >= "${cqlTs(cursor)}"`);
    const where = clauses.length > 0 ? `${clauses.join(" and ")} ` : "";
    const jql = `${where}order by updated asc, key asc`;
    const issues = await stableListing(
      "Jira incremental listing",
      () => this.scanIssues(jql, "key,updated"),
      (issue) => String(issue.key),
    );
    // Fetch and yield bodies sequentially after the cheap inventory agrees so
    // successful items advance the durable cursor before a later fetch fails.
    for (const issue of issues) yield await this.getIssue(String(issue.key));
  }

  /** Fetch one issue live — the get_doc fresh=true pull-through (flow K5). */
  async getIssue(key: string): Promise<JiraIssue> {
    const data = await getJson(this.client, `/rest/api/2/issue/${encodeURIComponent(key)}`, {
      fields: FIELDS,
    });
    return this.toIssueDict(data);
  }

  /** Complete id listing for reconcile (flow K1 deletions) — keys only, paged. */
  async listIds(scope?: string): Promise<string[]> {
    const where = scope ? `${scope} ` : "";
    const jql = `${where}order by key asc`;
    const issues = await stableListing(
      "Jira reconciliation listing",
      () => this.scanIssues(jql, "key"),
      (issue) => String(issue.key),
    );
    return issues.map((issue) => `jira:issue:${issue.key}`);
  }

  private async scanIssues(jql: string, fields: string): Promise<any[]> {
    const out: any[] = [];
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/2/search", {
        jql,
        fields,
        maxResults: PAGE_SIZE,
        startAt: start,
      });
      const issues = data.issues ?? [];
      out.push(...issues);
      start += issues.length;
      if (start >= (data.total ?? 0) || issues.length === 0) return out;
    }
  }

  toIssueDict(apiIssue: any): JiraIssue {
    const f = apiIssue.fields;
    const comments = (f.comment?.comments ?? []).map((c: any) => ({
      author: c.author?.displayName ?? "unknown",
      body: c.body ?? "",
      visibility: c.visibility ?? null,
    }));
    return {
      key: apiIssue.key,
      url: `${this.client.baseUrl}/browse/${apiIssue.key}`,
      fields: {
        summary: f.summary ?? "",
        status: f.status?.name ?? null,
        issuetype: f.issuetype?.name ?? null,
        project: f.project?.key ?? null,
        reporter: f.reporter?.displayName ?? null,
        created: f.created ?? null,
        updated: f.updated ?? null,
        description: f.description ?? "",
        comments,
        acl_groups: [],
        assignee: f.assignee?.displayName ?? null,
        labels: f.labels ?? [],
        priority: f.priority?.name ?? null,
        resolution: f.resolution?.name ?? null,
        components: (f.components ?? []).map((c: any) => c.name).filter(Boolean),
        fix_versions: (f.fixVersions ?? []).map((v: any) => v.name).filter(Boolean),
        parent: f.parent?.key ?? null,
        // Jira reports a link from whichever side it was created, so the
        // relevant key is inward OR outward. Taking only one direction would
        // silently halve the dependency graph.
        //
        // Label and key MUST come from the same side. A Jira link type carries
        // BOTH labels ("blocks" / "is blocked by"), so coalescing them
        // independently — `type.outward ?? type.inward` beside
        // `outwardIssue ?? inwardIssue` — reads the outward LABEL off a link
        // that only has an inward ISSUE, and reports "PAY-1 blocks PAY-2" when
        // the truth is the reverse. Harmless while the type was being
        // discarded; a wrong fact the moment it is persisted.
        issue_links: (f.issuelinks ?? [])
          .map((l: any) =>
            l.outwardIssue?.key
              ? { type: l.type?.outward ?? l.type?.name ?? "relates to", key: l.outwardIssue.key }
              : {
                  type: l.type?.inward ?? l.type?.name ?? "relates to",
                  key: l.inwardIssue?.key ?? "",
                },
          )
          .filter((l: any) => l.key),
      },
    };
  }
}
