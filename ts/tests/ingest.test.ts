import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentHash } from "../contracts/models.js";
import { normalize as normalizePage } from "../ingest/confluence.js";
import { normalize as normalizeIssue } from "../ingest/jira.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));

describe("normalizers", () => {
  it("confluence: extracts links and breadcrumb", () => {
    const doc = normalizePage(fixture("confluence_page.json"));
    expect(doc.id).toBe("confluence:page:12345");
    expect(doc.hierarchy).toEqual(["Payments Space", "Runbooks"]);
    expect(doc.links).toContain("jira:issue:PAY-981");
    expect(doc.links).toContain("obsidian:note:payments/parked-payments-runbook");
  });

  it("jira: builds body and links, never self-links", () => {
    const doc = normalizeIssue(fixture("jira_issue.json"));
    expect(doc.id).toBe("jira:issue:PAY-981");
    expect(doc.title.startsWith("PAY-981:")).toBe(true);
    expect(doc.body).toContain("## Comment — krunal");
    expect(doc.links).toContain("jira:issue:PAY-990");
    expect(doc.links).not.toContain("jira:issue:PAY-981");
  });

  it("hash gate is content-addressed", () => {
    const raw = fixture("confluence_page.json");
    expect(contentHash(normalizePage(raw))).toBe(contentHash(normalizePage(raw)));
    const edited = { ...raw, body: `${raw.body} edited` };
    expect(contentHash(normalizePage(edited))).not.toBe(contentHash(normalizePage(raw)));
  });
});
