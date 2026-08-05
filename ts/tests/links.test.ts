/**
 * The cross-source link graph — what distinguishes EIL from a vector-only
 * system, and what GraphRAG pays $20-50/M tokens to hallucinate approximations
 * of. It was mostly empty: no URL matcher existed at all, and Jira's own typed
 * dependency graph was never even requested from the API.
 */
import { describe, expect, it } from "vitest";
import { extractLinks, extractUrlLinks } from "../ingest/common.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { type JiraIssue, normalize as normalizeJira } from "../ingest/jira.js";

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
    const ids = doc.links.map((l) => l.id);
    expect(ids).toContain("jira:issue:PAY-42");
    expect(ids).toContain("jira:issue:PAY-7");
    expect(ids).toContain("jira:issue:PAY-1"); // epic / parent
  });

  it("never links an issue to itself", () => {
    // Asserted over `.id`: `links` holds objects now, so `not.toContain` on a
    // bare string is vacuously true and this guard silently stopped guarding.
    const doc = issue({ issue_links: [{ type: "relates to", key: "PAY-100" }] });
    expect(doc.links.some((l) => l.id === "jira:issue:PAY-100")).toBe(false);
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

/**
 * Jira's issuelinks are typed and exact — `blocks` is a different fact from
 * `duplicates`. The type was requested from the API and then discarded at
 * normalize, collapsing every relationship into one undifferentiated edge, so
 * `expand` could say two issues were connected but never why.
 *
 * The `links` table has carried `rel` in its primary key since migration 0001
 * and `expand` has always selected it; only the write path dropped it. So this
 * is a plumbing fix, not a schema change.
 */
describe("Jira link types survive normalization", () => {
  const issue = (fields: Partial<JiraIssue["fields"]> = {}) =>
    normalizeJira({
      key: "PAY-100",
      url: null,
      fields: {
        summary: "Retry storm",
        status: "Open",
        issuetype: "Bug",
        project: "PAY",
        description: "See PAY-999 for background.",
        ...fields,
      },
    } as JiraIssue);

  const relOf = (doc: ReturnType<typeof normalizeJira>, id: string) =>
    doc.links.find((l) => l.id === id)?.rel;

  it("keeps the relationship type Jira reported", () => {
    const doc = issue({
      issue_links: [
        { type: "blocks", key: "PAY-42" },
        { type: "duplicates", key: "PAY-43" },
      ],
    });
    expect(relOf(doc, "jira:issue:PAY-42")).toBe("blocks");
    expect(relOf(doc, "jira:issue:PAY-43")).toBe("duplicates");
  });

  it("normalizes multi-word link types to a stable slug", () => {
    const doc = issue({ issue_links: [{ type: "is blocked by", key: "PAY-44" }] });
    expect(relOf(doc, "jira:issue:PAY-44")).toBe("is-blocked-by");
  });

  it("labels the parent edge as a parent, not a generic reference", () => {
    expect(relOf(issue({ parent: "PAY-1" }), "jira:issue:PAY-1")).toBe("parent");
  });

  it("leaves prose-scraped edges as plain references", () => {
    // PAY-999 appears only in the description — a guess, not a declared fact.
    expect(relOf(issue(), "jira:issue:PAY-999")).toBe("references");
  });

  it("prefers the declared type when the same issue is also named in prose", () => {
    // Both a typed issuelink and a description mention. `rel` is part of the
    // links primary key, so emitting both would produce TWO edges for one
    // relationship — the exact duplication the original dedup existed to stop.
    const doc = issue({
      description: "Blocked by PAY-42, see PAY-42.",
      issue_links: [{ type: "blocks", key: "PAY-42" }],
    });
    const matches = doc.links.filter((l) => l.id === "jira:issue:PAY-42");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.rel).toBe("blocks");
  });

  it("never emits a self-edge", () => {
    const doc = issue({ issue_links: [{ type: "blocks", key: "PAY-100" }] });
    expect(doc.links.some((l) => l.id === "jira:issue:PAY-100")).toBe(false);
  });
});

describe("multiple declared relationships between the same pair", () => {
  const issue = (fields: Partial<JiraIssue["fields"]> = {}) =>
    normalizeJira({
      key: "PAY-500",
      url: null,
      fields: { summary: "s", project: "PAY", description: "d", ...fields },
    } as JiraIssue);

  it("keeps both, because the links primary key is (src, dst, rel)", () => {
    // Jira permits an issue to both block and duplicate the same target.
    // Collapsing to one edge per destination would discard a stated fact.
    const doc = issue({
      issue_links: [
        { type: "blocks", key: "PAY-42" },
        { type: "duplicates", key: "PAY-42" },
      ],
    });
    const rels = doc.links
      .filter((l) => l.id === "jira:issue:PAY-42")
      .map((l) => l.rel)
      .sort();
    expect(rels).toEqual(["blocks", "duplicates"]);
  });

  it("still collapses an exact duplicate of the same relationship", () => {
    const doc = issue({
      issue_links: [
        { type: "blocks", key: "PAY-42" },
        { type: "blocks", key: "PAY-42" },
      ],
    });
    expect(doc.links.filter((l) => l.id === "jira:issue:PAY-42")).toHaveLength(1);
  });

  it("drops the prose guess when any declared edge already names that target", () => {
    const doc = issue({
      description: "Blocked by PAY-42.",
      issue_links: [{ type: "blocks", key: "PAY-42" }],
    });
    const rels = doc.links.filter((l) => l.id === "jira:issue:PAY-42").map((l) => l.rel);
    expect(rels).toEqual(["blocks"]);
  });

  it("keeps the prose edge when nothing was declared for that target", () => {
    const doc = issue({ description: "See PAY-77." });
    const rels = doc.links.filter((l) => l.id === "jira:issue:PAY-77").map((l) => l.rel);
    expect(rels).toEqual(["references"]);
  });
});
