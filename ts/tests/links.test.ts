/**
 * The cross-source link graph — what distinguishes EIL from a vector-only
 * system, and what GraphRAG pays $20-50/M tokens to hallucinate approximations
 * of. It was mostly empty: no URL matcher existed at all, and Jira's own typed
 * dependency graph was never even requested from the API.
 */
import { describe, expect, it } from "vitest";
import { extractLinks, extractUrlLinks } from "../ingest/common.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { normalize as normalizeJira } from "../ingest/jira.js";

describe("URL references become edges", () => {
  it("resolves both Confluence URL shapes, on any host", () => {
    // Host-agnostic on purpose: matching the configured host would drop every
    // link written against a vanity domain, an alias, or the old hostname.
    expect(
      extractUrlLinks("see https://confluence.corp/pages/viewpage.action?pageId=12345 ok"),
    ).toEqual(["confluence:page:12345"]);
    expect(
      extractUrlLinks("see https://wiki.other.example/spaces/ENG/pages/67890/Retry+Policy"),
    ).toEqual(["confluence:page:67890"]);
  });

  it("resolves Jira browse URLs", () => {
    expect(extractUrlLinks("blocked by https://jira.corp/browse/PAY-981")).toEqual([
      "jira:issue:PAY-981",
    ]);
  });

  it("finds nothing in prose with no links", () => {
    expect(extractUrlLinks("Encode as UTF-8 and hash with SHA-256.")).toEqual([]);
  });

  it("combines URL and ticket-key edges, deduped, without standards tokens", () => {
    const body = [
      "Runbook: https://confluence.corp/pages/viewpage.action?pageId=12345",
      "Blocks PAY-981, see also https://jira.corp/browse/PAY-981 (same ticket).",
      "Encode as UTF-8 with SHA-256.",
    ].join("\n");
    const links = extractLinks(body, "confluence:page:1");
    expect(links).toContain("confluence:page:12345");
    expect(links.filter((l) => l === "jira:issue:PAY-981")).toHaveLength(1); // deduped
    expect(links).not.toContain("jira:issue:UTF-8");
  });
});

describe("Jira's own dependency graph", () => {
  const issue = (fields: Record<string, unknown>) =>
    normalizeJira({
      key: "PAY-100",
      url: null,
      fields: { summary: "Charge fails", status: "Open", issuetype: "Bug", ...fields },
    } as any);

  it("uses the typed issuelinks rather than scraping prose for keys", () => {
    const doc = issue({
      issue_links: [
        { type: "blocks", key: "PAY-42" },
        { type: "duplicates", key: "PAY-7" },
      ],
      parent: "PAY-1",
    });
    expect(doc.links).toContain("jira:issue:PAY-42");
    expect(doc.links).toContain("jira:issue:PAY-7");
    expect(doc.links).toContain("jira:issue:PAY-1"); // epic / parent
  });

  it("never links an issue to itself", () => {
    expect(issue({ issue_links: [{ type: "relates to", key: "PAY-100" }] }).links).not.toContain(
      "jira:issue:PAY-100",
    );
  });

  it("puts facets in the BODY, because the lexical arm can only match text", () => {
    const doc = issue({
      assignee: "Alice Smith",
      priority: "High",
      resolution: "Fixed",
      labels: ["payments", "incident"],
      components: ["billing"],
    });
    for (const want of ["Alice Smith", "High", "Fixed", "payments", "incident", "billing"])
      expect(doc.body).toContain(want);
  });

  it("omits absent facets rather than emitting empty ones", () => {
    const doc = issue({});
    expect(doc.body).not.toContain("**Assignee:**");
    expect(doc.body).not.toContain("**Labels:**");
    expect(doc.body).toContain("**Status:**");
  });
});

describe("Confluence labels", () => {
  const page = (labels?: string[]) =>
    normalizeConfluence({
      id: "999",
      title: "Retry Policy",
      url: null,
      author: null,
      updated: null,
      created: null,
      ancestors: ["ENG"],
      acl_groups: [],
      ...(labels ? { labels } : {}),
      body: "Retries use exponential backoff.",
    } as any);

  it("are searchable, having previously been dropped entirely", () => {
    // docs/ingestion.md already advertises `--query 'label = incident'`.
    expect(page(["incident", "runbook"]).body).toContain("incident");
    expect(page(["incident", "runbook"]).body).toContain("runbook");
  });

  it("leave an unlabelled page untouched", () => {
    expect(page().body).toBe("Retries use exponential backoff.");
  });
});
