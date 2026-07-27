/** Connector tests against injected fetch mocks — mapping and pagination
 * verified without org access. */

import { describe, expect, it } from "vitest";
import type { Fetcher } from "../connectors/auth.js";
import { BitbucketSearchClient } from "../connectors/bitbucket.js";
import { ConfluenceClient, cqlTs } from "../connectors/confluence.js";
import { ElkClient } from "../connectors/elk.js";
import { JiraClient } from "../connectors/jira.js";
import { normalize as normalizePage } from "../ingest/confluence.js";
import { normalize as normalizeIssue } from "../ingest/jira.js";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

it("cqlTs formats ISO cursors", () => {
  expect(cqlTs("2026-06-02T14:30:00+00:00")).toBe("2026-06-02 14:30");
});

describe("confluence", () => {
  it("maps API pages into the normalizer contract", async () => {
    const apiPage = {
      id: "777",
      title: "Parked Payments Runbook",
      space: { name: "Payments Space" },
      ancestors: [{ title: "Runbooks" }],
      version: { when: "2026-06-03T10:00:00+00:00", by: { displayName: "asha" } },
      _links: { webui: "/pages/777" },
      body: { storage: { value: "<h2>Steps</h2><p>Check PAY-981 first.</p>" } },
    };
    const fetcher: Fetcher = async (url) => {
      const cql = new URL(String(url)).searchParams.get("cql");
      expect(cql).toContain('lastmodified >= "2026-06-01 00:00"');
      return jsonResponse({ results: [apiPage], size: 1 });
    };
    const client = new ConfluenceClient("https://confluence.example.com", "pat", fetcher);
    const pages = [];
    for await (const p of client.updatedSince("2026-06-01T00:00:00+00:00")) pages.push(p);
    expect(pages).toHaveLength(1);
    const doc = normalizePage(pages[0]!);
    expect(doc.id).toBe("confluence:page:777");
    expect(doc.hierarchy).toEqual(["Payments Space", "Runbooks"]);
    expect(doc.body).toContain("## Steps");
    expect(doc.links).toContain("jira:issue:PAY-981");
    expect(doc.url).toBe("https://confluence.example.com/pages/777");
  });
});

describe("jira", () => {
  it("paginates and maps issues", async () => {
    const makeIssue = (n: number) => ({
      key: `PAY-${n}`,
      fields: {
        summary: `issue ${n}`,
        status: { name: "Open" },
        issuetype: { name: "Bug" },
        project: { key: "PAY" },
        reporter: { displayName: "krunal" },
        updated: `2026-06-0${n}T00:00:00+00:00`,
        description: "d",
        comment: { comments: [{ author: { displayName: "a" }, body: "c" }] },
      },
    });
    const calls: number[] = [];
    const fetcher: Fetcher = async (url) => {
      const start = Number(new URL(String(url)).searchParams.get("startAt"));
      calls.push(start);
      return jsonResponse({ issues: [makeIssue(start === 0 ? 1 : 2)], total: 2, startAt: start });
    };
    const client = new JiraClient("https://jira.example.com", "pat", fetcher);
    const issues = [];
    for await (const i of client.updatedSince(null)) issues.push(i);
    expect(issues.map((i) => i.key)).toEqual(["PAY-1", "PAY-2"]);
    expect(calls).toEqual([0, 1]);
    const doc = normalizeIssue(issues[0]!);
    expect(doc.id).toBe("jira:issue:PAY-1");
    expect(doc.url).toBe("https://jira.example.com/browse/PAY-1");
  });
});

describe("bitbucket", () => {
  it("maps hits and enforces the query limit", async () => {
    const fetcher: Fetcher = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.entities).toEqual({ code: {} });
      return jsonResponse({
        code: {
          count: 1,
          values: [
            {
              repository: { slug: "payments-svc", project: { key: "PAY" } },
              file: "src/retry/scheduler.py",
              hitContexts: [[{ line: 42, text: "def handle_retry():" }]],
            },
          ],
        },
      });
    };
    const client = new BitbucketSearchClient("https://bitbucket.example.com", "pat", fetcher);
    const result: any = await client.searchCode("handle_retry");
    expect(result.count).toBe(1);
    expect(result.results[0].repo).toBe("PAY/payments-svc");
    expect(result.results[0].lines[0].line).toBe(42);

    const tooLong: any = await client.searchCode("x".repeat(300));
    expect(tooLong.error).toBeDefined();
    expect(tooLong.results).toEqual([]);
  });
});

describe("elk", () => {
  it("builds the query and caps output", async () => {
    const fetcher: Fetcher = async (url, init) => {
      expect(String(url)).toContain("/logs-payments-*/_search");
      const body = JSON.parse(String(init?.body));
      expect(body.query.bool.must[0].query_string.query).toBe(
        'RETRY_EXHAUSTED AND service:"retry-scheduler"',
      );
      expect(body.query.bool.filter[0].range["@timestamp"].gte).toBe("now-30m");
      return jsonResponse({
        hits: {
          total: { value: 2 },
          hits: [
            {
              _source: {
                "@timestamp": "2026-07-27T00:00:00Z",
                level: "ERROR",
                service: "retry-scheduler",
                message: "x".repeat(1000),
              },
            },
            {
              _source: {
                "@timestamp": "2026-07-26T23:59:00Z",
                "log.level": "WARN",
                message: "parked",
              },
            },
          ],
        },
      });
    };
    const client = new ElkClient("https://elk.example.com", "pat", fetcher);
    const out: any = await client.fetchLogs(
      'RETRY_EXHAUSTED AND service:"retry-scheduler"',
      "logs-payments-*",
      30,
    );
    expect(out.total).toBe(2);
    expect(out.results[0].message).toHaveLength(400);
    expect(out.results[1].level).toBe("WARN");
  });

  it("hard-caps the limit", async () => {
    const fetcher: Fetcher = async (_url, init) => {
      expect(JSON.parse(String(init?.body)).size).toBe(50);
      return jsonResponse({ hits: { total: { value: 0 }, hits: [] } });
    };
    const client = new ElkClient("https://elk.example.com", "pat", fetcher);
    await client.fetchLogs("q", undefined, 60, 500);
  });
});
