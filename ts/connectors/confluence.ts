/**
 * Live Confluence DC connector: cursor-based CQL incremental sync.
 * Personal-credential rule: EIL_CONFLUENCE_TOKEN is YOUR PAT — ACL by
 * construction locally. Output feeds ingest/confluence.normalize unchanged.
 */

import type { ConfluencePage } from "../ingest/confluence.js";
import { type DcClient, type Fetcher, getJson, makeClient } from "./auth.js";
import { htmlToMarkdown } from "./htmlmd.js";

export const PAGE_SIZE = 50;

/** ISO timestamp -> the 'yyyy-MM-dd HH:mm' form CQL/JQL accept. */
export function cqlTs(isoCursor: string): string {
  return isoCursor.slice(0, 16).replace("T", " ");
}

export class ConfluenceClient {
  readonly client: DcClient;

  constructor(baseUrl?: string, token?: string, fetcher?: Fetcher) {
    this.client = makeClient("CONFLUENCE", baseUrl, token, fetcher);
  }

  async *updatedSince(cursor: string | null, scope?: string): AsyncGenerator<ConfluencePage> {
    const clauses = ["type=page"];
    if (scope) clauses.push(scope);
    if (cursor) clauses.push(`lastmodified >= "${cqlTs(cursor)}"`);
    const cql = `${clauses.join(" and ")} order by lastmodified asc`;
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/content/search", {
        cql,
        expand: "body.storage,ancestors,version,space,metadata.labels",
        limit: PAGE_SIZE,
        start,
      });
      for (const page of data.results ?? []) yield this.toPageDict(page);
      if ((data.size ?? 0) < PAGE_SIZE) return;
      start += PAGE_SIZE;
    }
  }

  /** Fetch one page live — the get_doc fresh=true pull-through (flow K5). */
  async getPage(id: string): Promise<ConfluencePage> {
    const data = await getJson(this.client, `/rest/api/content/${encodeURIComponent(id)}`, {
      expand: "body.storage,ancestors,version,space,metadata.labels",
    });
    return this.toPageDict(data);
  }

  /** Page subtree for --with-descendants: every page under `pageId`, any depth. */
  async *descendants(pageId: string): AsyncGenerator<ConfluencePage> {
    const cql = `ancestor = ${pageId} order by lastmodified asc`;
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/content/search", {
        cql,
        expand: "body.storage,ancestors,version,space,metadata.labels",
        limit: PAGE_SIZE,
        start,
      });
      for (const page of data.results ?? []) yield this.toPageDict(page);
      if ((data.size ?? 0) < PAGE_SIZE) return;
      start += PAGE_SIZE;
    }
  }

  /** Complete id listing for reconcile (flow K1 deletions) — ids only, paged. */
  async listIds(scope?: string): Promise<string[]> {
    const clauses = ["type=page"];
    if (scope) clauses.push(scope);
    const cql = `${clauses.join(" and ")} order by id asc`;
    const ids: string[] = [];
    let start = 0;
    for (;;) {
      const data = await getJson(this.client, "/rest/api/content/search", {
        cql,
        limit: PAGE_SIZE,
        start,
      });
      for (const page of data.results ?? []) ids.push(`confluence:page:${page.id}`);
      if ((data.size ?? 0) < PAGE_SIZE) return ids;
      start += PAGE_SIZE;
    }
  }

  /** Map a Confluence API response item to the normalizer's page shape. */
  toPageDict(apiPage: any): ConfluencePage {
    const version = apiPage.version ?? {};
    const space = apiPage.space?.name;
    const ancestors = (apiPage.ancestors ?? []).map((a: any) => a.title ?? "");
    const webui = apiPage._links?.webui ?? "";
    return {
      id: apiPage.id,
      title: apiPage.title,
      url: webui ? `${this.client.baseUrl}${webui}` : null,
      author: version.by?.displayName ?? null,
      updated: version.when ?? null,
      created: null,
      ancestors: [...(space ? [space] : []), ...ancestors],
      acl_groups: [], // stamped by the phase-2 ACL syncer; empty = fail-closed
      // Labels are the single most useful Confluence facet — docs/ingestion.md
      // already advertises `--query 'label = incident'` — and they were dropped
      // entirely. Prepended to the body so the lexical arm can match them; there
      // is nowhere else for a term to hit.
      labels: (apiPage.metadata?.labels?.results ?? [])
        .map((l: any) => l.name ?? l.label)
        .filter(Boolean),
      body: htmlToMarkdown(apiPage.body?.storage?.value ?? ""),
    };
  }
}
