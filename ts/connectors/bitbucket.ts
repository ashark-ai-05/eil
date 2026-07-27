/**
 * search_code v0: Bitbucket DC built-in search behind the MCP contract.
 * Native repo permissions apply under your PAT; known limits instrumented via
 * the audit log so real failure data schedules the Zoekt v1 decision.
 */

import { type DcClient, type Fetcher, makeClient, postJson } from "./auth.js";

export const QUERY_MAX_CHARS = 250;

export class BitbucketSearchClient {
  readonly client: DcClient;

  constructor(baseUrl?: string, token?: string, fetcher?: Fetcher) {
    this.client = makeClient("BITBUCKET", baseUrl, token, fetcher);
  }

  async searchCode(query: string, limit = 10): Promise<Record<string, unknown>> {
    if (query.length > QUERY_MAX_CHARS) {
      return { error: `query exceeds Bitbucket's ${QUERY_MAX_CHARS}-char limit`, results: [] };
    }
    const data = await postJson(this.client, "/rest/search/latest/search", {
      query,
      entities: { code: {} },
      limits: { primary: limit },
    });
    const code = data.code ?? {};
    const results = (code.values ?? []).map((hit: any) => {
      const repo = hit.repository ?? {};
      const lines = (hit.hitContexts ?? [])
        .flat()
        .map((ctx: any) => ({ line: ctx.line, text: ctx.text ?? "" }));
      return {
        repo: `${repo.project?.key ?? "?"}/${repo.slug ?? "?"}`,
        path: hit.file ?? "",
        lines: lines.slice(0, 6), // keep tool output compact
      };
    });
    return { query, count: code.count ?? results.length, results };
  }
}
