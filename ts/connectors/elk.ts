/**
 * fetch_logs: live query against the hosted logging ELK. Logs are NEVER
 * ingested — queried where they live, with hard caps (context bombs).
 */

import { type DcClient, type Fetcher, makeClient, postJson } from "./auth.js";

export const MAX_HITS = 50;
export const MESSAGE_MAX_CHARS = 400;

export class ElkClient {
  readonly client: DcClient;
  readonly defaultIndex: string;

  constructor(baseUrl?: string, token?: string, fetcher?: Fetcher) {
    this.client = makeClient("ELK", baseUrl, token, fetcher);
    this.defaultIndex = process.env.EIL_ELK_INDEX ?? "logs-*";
  }

  async fetchLogs(
    query: string,
    index?: string,
    minutes = 60,
    limit = 20,
  ): Promise<Record<string, unknown>> {
    const size = Math.min(limit, MAX_HITS);
    const data = await postJson(this.client, `/${index ?? this.defaultIndex}/_search`, {
      size,
      sort: [{ "@timestamp": "desc" }],
      query: {
        bool: {
          must: [{ query_string: { query } }],
          filter: [{ range: { "@timestamp": { gte: `now-${minutes}m` } } }],
        },
      },
    });
    const hits = data.hits ?? {};
    const results = (hits.hits ?? []).map((h: any) => {
      const src = h._source ?? {};
      return {
        ts: src["@timestamp"],
        level: src.level ?? src["log.level"],
        service: src.service ?? src.kubernetes?.container?.name,
        message: String(src.message ?? "").slice(0, MESSAGE_MAX_CHARS),
      };
    });
    const total = hits.total;
    return {
      query,
      window_minutes: minutes,
      total: typeof total === "object" && total !== null ? total.value : (total ?? results.length),
      results,
    };
  }
}
