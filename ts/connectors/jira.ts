/**
 * Live Jira DC connector: cursor-based JQL incremental sync. Output feeds
 * ingest/jira.normalize unchanged. Descriptions are wiki markup — close
 * enough for FTS.
 */

import type { JiraIssue } from "../ingest/jira.js";
import { type DcClient, type Fetcher, getJson, makeClient } from "./auth.js";
import { cqlTs } from "./confluence.js";

export const PAGE_SIZE = 50;
const FIELDS = "summary,description,status,issuetype,project,reporter,created,updated,comment";

export class JiraClient {
  readonly client: DcClient;

  constructor(baseUrl?: string, token?: string, fetcher?: Fetcher) {
    this.client = makeClient("JIRA", baseUrl, token, fetcher);
  }

  async *updatedSince(cursor: string | null): AsyncGenerator<JiraIssue> {
    let jql = "order by updated asc";
    if (cursor) jql = `updated >= "${cqlTs(cursor)}" order by updated asc`;
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/2/search", {
        jql,
        fields: FIELDS,
        maxResults: PAGE_SIZE,
        startAt: start,
      });
      const issues = data.issues ?? [];
      for (const issue of issues) yield this.toIssueDict(issue);
      start += issues.length;
      if (start >= (data.total ?? 0) || issues.length === 0) return;
    }
  }

  /** Fetch one issue live — the get_doc fresh=true pull-through (flow K5). */
  async getIssue(key: string): Promise<JiraIssue> {
    const data = await getJson(this.client, `/rest/api/2/issue/${encodeURIComponent(key)}`, {
      fields: FIELDS,
    });
    return this.toIssueDict(data);
  }

  /** Complete id listing for reconcile (flow K1 deletions) — keys only, paged. */
  async listIds(): Promise<string[]> {
    const ids: string[] = [];
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/2/search", {
        jql: "order by key asc",
        fields: "key",
        maxResults: PAGE_SIZE,
        startAt: start,
      });
      const issues = data.issues ?? [];
      for (const issue of issues) ids.push(`jira:issue:${issue.key}`);
      start += issues.length;
      if (start >= (data.total ?? 0) || issues.length === 0) return ids;
    }
  }

  toIssueDict(apiIssue: any): JiraIssue {
    const f = apiIssue.fields;
    const comments = (f.comment?.comments ?? []).map((c: any) => ({
      author: c.author?.displayName ?? "unknown",
      body: c.body ?? "",
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
      },
    };
  }
}
