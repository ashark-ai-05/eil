/** Connector tests against injected fetch mocks — mapping and pagination
 * verified without org access. */

import { describe, expect, it } from "vitest";
import { type Fetcher, makeClient } from "../connectors/auth.js";
import {
  BitbucketSearchClient,
  doctorProbe as bitbucketDoctorProbe,
} from "../connectors/bitbucket.js";
import { ConfluenceClient, PAGE_SIZE, cqlTs } from "../connectors/confluence.js";
import { ElkClient, doctorProbe as elkDoctorProbe } from "../connectors/elk.js";
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
      history: { createdDate: "2026-05-01T09:00:00+00:00" },
      _links: { webui: "/pages/777" },
      body: { storage: { value: "<h2>Steps</h2><p>Check PAY-981 first.</p>" } },
    };
    const fetcher: Fetcher = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/rest/api/content/777")) return jsonResponse(apiPage);
      expect(parsed.searchParams.get("cql")).toContain('lastmodified >= "2026-06-01 00:00"');
      return jsonResponse({ results: [{ id: "777", version: apiPage.version }], size: 1 });
    };
    const client = new ConfluenceClient("https://confluence.example.com", "pat", fetcher);
    const pages = [];
    for await (const p of client.updatedSince("2026-06-01T00:00:00+00:00")) pages.push(p);
    expect(pages).toHaveLength(1);
    const doc = normalizePage(pages[0]!);
    expect(doc.id).toBe("confluence:page:777");
    expect(doc.hierarchy).toEqual(["Payments Space", "Runbooks"]);
    expect(doc.body).toContain("## Steps");
    expect(doc.links.map((l) => l.id)).toContain("jira:issue:PAY-981");
    expect(doc.url).toBe("https://confluence.example.com/pages/777");
    expect(doc.createdAt).toBe("2026-05-01T09:00:00+00:00");
  });
});

describe("confluence scoped", () => {
  const apiPage = (id: string) => ({
    id,
    title: `p${id}`,
    space: { name: "S" },
    ancestors: [],
    version: { when: "2026-06-03T10:00:00+00:00", by: { displayName: "a" } },
    _links: { webui: `/pages/${id}` },
    body: { storage: { value: "<p>x</p>" } },
  });

  it("with no scope builds the exact legacy CQL (regression)", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("cql") ?? "";
      return jsonResponse({ results: [], size: 0 });
    };
    const c = new ConfluenceClient("https://x", "t", fetcher);
    for await (const _ of c.updatedSince(null)) {
      /* drain */
    }
    expect(seen).toBe("type=page order by lastmodified asc, id asc");
  });

  it("injects a space predicate", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("cql") ?? "";
      return jsonResponse({ results: [], size: 0 });
    };
    const c = new ConfluenceClient("https://x", "t", fetcher);
    for await (const _ of c.updatedSince(null, 'space = "ENG"')) {
      /* drain */
    }
    expect(seen).toBe('type=page and space = "ENG" order by lastmodified asc, id asc');
  });

  it("descendants queries ancestor = id", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/rest/api/content/9")) return jsonResponse(apiPage("9"));
      seen = parsed.searchParams.get("cql") ?? "";
      return jsonResponse({ results: [{ id: "9", version: apiPage("9").version }], size: 1 });
    };
    const c = new ConfluenceClient("https://x", "t", fetcher);
    const out = [];
    for await (const p of c.descendants("100")) {
      out.push(p);
    }
    expect(seen).toBe("ancestor = 100 order by lastmodified asc, id asc");
    expect(out).toHaveLength(1);
  });

  it("scoped listIds carries the predicate", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("cql") ?? "";
      return jsonResponse({ results: [], size: 0 });
    };
    const c = new ConfluenceClient("https://x", "t", fetcher);
    await c.listIds('space = "ENG"');
    expect(seen).toBe('type=page and space = "ENG" order by id asc');
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
        comment: {
          comments: [
            {
              author: { displayName: "a" },
              body: "c",
              visibility: { type: "role", value: "Administrators" },
            },
          ],
        },
      },
    });
    const calls: number[] = [];
    const fetcher: Fetcher = async (url) => {
      const parsed = new URL(String(url));
      const issueKey = parsed.pathname.match(/\/issue\/(PAY-\d+)$/)?.[1];
      if (issueKey) return jsonResponse(makeIssue(Number(issueKey.split("-")[1])));
      const start = Number(parsed.searchParams.get("startAt"));
      calls.push(start);
      const issue = makeIssue(start === 0 ? 1 : 2);
      return jsonResponse({
        issues: [{ key: issue.key, fields: { updated: issue.fields.updated } }],
        total: 2,
        startAt: start,
      });
    };
    const client = new JiraClient("https://jira.example.com", "pat", fetcher);
    const issues = [];
    for await (const i of client.updatedSince(null)) issues.push(i);
    expect(issues.map((i) => i.key)).toEqual(["PAY-1", "PAY-2"]);
    expect((issues[0]!.fields.comments?.[0] as any).visibility).toEqual({
      type: "role",
      value: "Administrators",
    });
    expect(calls).toEqual([0, 1, 0, 1]);
    const doc = normalizeIssue(issues[0]!);
    expect(doc.id).toBe("jira:issue:PAY-1");
    expect(doc.url).toBe("https://jira.example.com/browse/PAY-1");
  });
});

describe("jira link direction", () => {
  /**
   * A Jira link TYPE carries both labels ("blocks" and "is blocked by"), while
   * the linked issue appears under either `outwardIssue` or `inwardIssue`.
   * Coalescing them independently — `type.outward ?? type.inward` beside
   * `outwardIssue ?? inwardIssue` — reads the outward label off a link that
   * only has an inward issue and states the relationship backwards.
   *
   * Latent while the type was discarded at normalize; a wrong fact the moment
   * link types began to persist.
   */
  const issueWith = (link: unknown) => ({
    key: "PAY-1",
    fields: {
      summary: "s",
      project: { key: "PAY" },
      updated: "2026-06-01T00:00:00+00:00",
      comment: { comments: [] },
      issuelinks: [link],
    },
  });

  // The search endpoint returns a thin inventory and each issue is then
  // fetched individually, so the mock has to serve both shapes.
  const linksOf = async (link: unknown) => {
    const issue = issueWith(link);
    const fetcher: Fetcher = async (url) => {
      const parsed = new URL(String(url));
      if (/\/issue\/PAY-1$/.test(parsed.pathname)) return jsonResponse(issue);
      return jsonResponse({
        issues: [{ key: issue.key, fields: { updated: issue.fields.updated } }],
        total: 1,
        startAt: Number(parsed.searchParams.get("startAt") ?? 0),
      });
    };
    const client = new JiraClient("https://jira.example.com", "pat", fetcher);
    const out = [];
    for await (const i of client.updatedSince(null)) out.push(i);
    return out[0]?.fields.issue_links ?? [];
  };

  it("labels an outward link with the outward phrase", async () => {
    expect(
      await linksOf({
        type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
        outwardIssue: { key: "PAY-2" },
      }),
    ).toEqual([{ type: "blocks", key: "PAY-2" }]);
  });

  it("labels an inward link with the INWARD phrase, not the outward one", async () => {
    expect(
      await linksOf({
        type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
        inwardIssue: { key: "PAY-3" },
      }),
    ).toEqual([{ type: "is blocked by", key: "PAY-3" }]);
  });
});

describe("jira scoped", () => {
  it("with no scope builds the exact legacy JQL (regression)", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("jql") ?? "";
      return jsonResponse({ issues: [], total: 0 });
    };
    const c = new JiraClient("https://x", "t", fetcher);
    for await (const _ of c.updatedSince(null)) {
      /* drain */
    }
    expect(seen).toBe("order by updated asc, key asc");
  });

  it("injects a project predicate and composes with the cursor", async () => {
    const seen: string[] = [];
    const fetcher: Fetcher = async (url) => {
      seen.push(new URL(String(url)).searchParams.get("jql") ?? "");
      return jsonResponse({ issues: [], total: 0 });
    };
    const c = new JiraClient("https://x", "t", fetcher);
    for await (const _ of c.updatedSince(null, 'project = "PAY"')) {
      /* drain */
    }
    for await (const _ of c.updatedSince("2026-06-01T00:00:00+00:00", 'project = "PAY"')) {
      /* drain */
    }
    expect(seen).toEqual([
      'project = "PAY" order by updated asc, key asc',
      'project = "PAY" order by updated asc, key asc',
      'project = "PAY" and updated >= "2026-06-01 00:00" order by updated asc, key asc',
      'project = "PAY" and updated >= "2026-06-01 00:00" order by updated asc, key asc',
    ]);
  });

  it("scoped listIds carries the predicate", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = new URL(String(url)).searchParams.get("jql") ?? "";
      return jsonResponse({ issues: [], total: 0 });
    };
    const c = new JiraClient("https://x", "t", fetcher);
    await c.listIds('project = "PAY"');
    expect(seen).toBe('project = "PAY" order by key asc');
  });
});

describe("reconcile listings and single-item fetchers", () => {
  it("confluence listIds pages through ids only", async () => {
    const calls: number[] = [];
    const fetcher: Fetcher = async (url) => {
      const u = new URL(String(url));
      calls.push(Number(u.searchParams.get("start")));
      expect(u.searchParams.get("expand")).toBeNull(); // ids only — no body fetch
      const start = Number(u.searchParams.get("start"));
      const batch =
        start === 0 ? Array.from({ length: 50 }, (_, i) => ({ id: String(i) })) : [{ id: "50" }];
      return jsonResponse({ results: batch, size: batch.length });
    };
    const client = new ConfluenceClient("https://c.example.com", "pat", fetcher);
    const ids = await client.listIds();
    expect(ids).toHaveLength(51);
    expect(ids[0]).toBe("confluence:page:0");
    expect(calls).toEqual([0, 50, 0, 50]);
  });

  it("jira listIds pages through keys only", async () => {
    const fetcher: Fetcher = async (url) => {
      const u = new URL(String(url));
      expect(u.searchParams.get("fields")).toBe("key");
      const start = Number(u.searchParams.get("startAt"));
      return jsonResponse({
        issues: start === 0 ? [{ key: "PAY-1" }, { key: "PAY-2" }] : [],
        total: 2,
      });
    };
    const client = new JiraClient("https://j.example.com", "pat", fetcher);
    expect(await client.listIds()).toEqual(["jira:issue:PAY-1", "jira:issue:PAY-2"]);
  });

  it("getPage and getIssue fetch single items for fresh=true", async () => {
    const cFetcher: Fetcher = async (url) => {
      expect(String(url)).toContain("/rest/api/content/777");
      return jsonResponse({
        id: "777",
        title: "T",
        version: {},
        body: { storage: { value: "<p>x</p>" } },
      });
    };
    const page = await new ConfluenceClient("https://c.example.com", "pat", cFetcher).getPage(
      "777",
    );
    expect(page.id).toBe("777");

    const jFetcher: Fetcher = async (url) => {
      expect(String(url)).toContain("/rest/api/2/issue/PAY-9");
      return jsonResponse({ key: "PAY-9", fields: { summary: "s" } });
    };
    const issue = await new JiraClient("https://j.example.com", "pat", jFetcher).getIssue("PAY-9");
    expect(issue.key).toBe("PAY-9");
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

  // searchCode's postJson call declares idempotency: "query" — a mutation to
  // "none" would make this fail (the first 503 would surface immediately
  // instead of being retried), so this test is the regression Codex's design
  // review asked for: proof the retry-safety choice is actually load-bearing,
  // not just a call site that happens to work either way.
  it("retries a transient search failure (proves the 'query' idempotency choice is exercised, not incidental)", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls++;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return jsonResponse({ code: { count: 0, values: [] } });
    };
    const client = new BitbucketSearchClient("https://bitbucket.example.com", "pat", fetcher);
    const result: any = await client.searchCode("handle_retry");
    expect(result.count).toBe(0);
    expect(calls).toBe(2);
  });

  it("doctorProbe checks the identity-scoped recent-repos endpoint, not instance metadata a public endpoint could satisfy anonymously", async () => {
    const fetcher: Fetcher = async (url) => {
      const u = String(url);
      // Instance metadata succeeds even for an invalid/no token on some
      // configurations — proves nothing about this specific credential.
      if (u.includes("/application-properties")) return jsonResponse({ version: "8.9.0" });
      if (u.includes("/profile/recent/repos")) return new Response("unauthorized", { status: 401 });
      throw new Error(`unexpected doctorProbe call: ${u}`);
    };
    const client = makeClient("BITBUCKET", "https://bitbucket.example.com", "pat", fetcher);
    // The real probe hits the identity-scoped endpoint and correctly fails,
    // never the metadata endpoint that would have reported false success.
    await expect(bitbucketDoctorProbe(client)).rejects.toThrow();
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

  // Same regression as bitbucket's above: fetchLogs's postJson call declares
  // idempotency: "query" (an ES _search is a read) — mutating that to "none"
  // would make this fail.
  it("retries a transient search failure (proves the 'query' idempotency choice is exercised)", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls++;
      if (calls === 1) return new Response("service unavailable", { status: 503 });
      return jsonResponse({ hits: { total: { value: 0 }, hits: [] } });
    };
    const client = new ElkClient("https://elk.example.com", "pat", fetcher);
    const out: any = await client.fetchLogs("q");
    expect(out.total).toBe(0);
    expect(calls).toBe(2);
  });

  it("doctorProbe searches the configured index rather than checking cluster health — works even when cluster-monitor would be forbidden", async () => {
    const fetcher: Fetcher = async (url) => {
      const u = String(url);
      // An index-scoped credential need not have cluster-monitor privileges
      // — if the probe used /_cluster/health, this would fail a token the
      // real EIL search path can use just fine.
      if (u.includes("/_cluster/health")) return new Response("forbidden", { status: 403 });
      if (u.includes("/logs-custom-*/_search")) {
        return jsonResponse({ hits: { total: { value: 0 }, hits: [] } });
      }
      throw new Error(`unexpected doctorProbe call: ${u}`);
    };
    const client = makeClient("ELK", "https://elk.example.com", "pat", fetcher);
    await expect(
      elkDoctorProbe(client, { EIL_ELK_INDEX: "logs-custom-*" }),
    ).resolves.toBeUndefined();
  });

  it("doctorProbe falls back to logs-* when no index is configured, matching fetchLogs' own default", async () => {
    const fetcher: Fetcher = async (url) => {
      expect(String(url)).toContain("/logs-*/_search");
      return jsonResponse({ hits: { total: { value: 0 }, hits: [] } });
    };
    const client = makeClient("ELK", "https://elk.example.com", "pat", fetcher);
    await elkDoctorProbe(client, {});
  });
});

describe("getJson retry mechanics", () => {
  it("gives each retry attempt its own fresh AbortSignal, never a reused/already-aborted one", async () => {
    let calls = 0;
    const seenSignals: AbortSignal[] = [];
    const fetcher: Fetcher = async (_url, init) => {
      calls++;
      const signal = init?.signal as AbortSignal;
      seenSignals.push(signal);
      expect(signal.aborted).toBe(false); // never handed an already-aborted signal
      if (calls < 3) return new Response("rate limited", { status: 429 });
      return jsonResponse({ id: "777", title: "t", version: {}, body: { storage: { value: "" } } });
    };
    await new ConfluenceClient("https://c.example.com", "pat", fetcher).getPage("777");
    expect(calls).toBe(3);
    // Each attempt got a distinct AbortSignal object, not the same one reused
    // (and therefore already-fired) across retries.
    expect(new Set(seenSignals).size).toBe(3);
  });
});

describe("mutable offset pagination", () => {
  const page = (id: number) => ({
    id: String(id),
    title: `p${id}`,
    space: { name: "S" },
    ancestors: [],
    version: { when: "2026-06-03T10:00:00+00:00", by: { displayName: "a" } },
    body: { storage: { value: "<p>x</p>" } },
  });

  it("does not expose a Confluence listing until two complete scans agree", async () => {
    let scan = 0;
    const starts: number[] = [];
    const fetcher: Fetcher = async (url) => {
      const parsed = new URL(String(url));
      const pageId = parsed.pathname.match(/\/content\/(\d+)$/)?.[1];
      if (pageId) return jsonResponse(page(Number(pageId)));
      const start = Number(parsed.searchParams.get("start"));
      if (start === 0) scan++;
      starts.push(start);
      if (start === 0)
        return jsonResponse({ results: Array.from({ length: 50 }, (_, i) => page(i)), size: 50 });
      if (start === 50 && scan === 1)
        return jsonResponse({
          results: Array.from({ length: 49 }, (_, i) => page(i + 51)),
          size: 49,
        });
      if (start === 50)
        return jsonResponse({
          results: Array.from({ length: 50 }, (_, i) => page(i + 50)),
          size: 50,
        });
      return jsonResponse({ results: [], size: 0 });
    };
    const out = [];
    for await (const p of new ConfluenceClient("https://x", "t", fetcher).updatedSince(null))
      out.push(p.id);
    expect(out).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
    expect(starts).toEqual([0, 50, 0, 50, 100, 0, 50, 100]);
  });

  it("yields agreed Confluence bodies incrementally before a later fetch fails", async () => {
    const fetcher: Fetcher = async (url) => {
      const parsed = new URL(String(url));
      const pageId = parsed.pathname.match(/\/content\/(\d+)$/)?.[1];
      if (pageId === "2") throw new Error("rate limited");
      if (pageId) return jsonResponse(page(Number(pageId)));
      return jsonResponse({ results: [0, 1, 2].map((id) => ({ id: String(id) })), size: 3 });
    };
    const yielded: string[] = [];
    await expect(async () => {
      for await (const item of new ConfluenceClient("https://x", "t", fetcher).updatedSince(null))
        yielded.push(item.id);
    }).rejects.toThrow("rate limited");
    expect(yielded).toEqual(["0", "1"]);
  });

  it("refuses a reconciliation listing that never stabilizes", async () => {
    let scan = 0;
    const fetcher: Fetcher = async (url) => {
      const start = Number(new URL(String(url)).searchParams.get("start"));
      if (start === 0) scan++;
      return jsonResponse({
        results: start === 0 ? [{ id: String(scan) }] : [],
        size: start === 0 ? 1 : 0,
      });
    };
    await expect(new ConfluenceClient("https://x", "t", fetcher).listIds()).rejects.toThrow(
      "refusing an incomplete listing after 3 scans",
    );
  });
});
