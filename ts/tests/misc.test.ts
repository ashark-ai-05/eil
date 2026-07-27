import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGolden } from "../evalrun.js";
import { walkVault } from "../ingest/obsidian.js";
import { CliProvider, getProvider, parseJsonReply } from "../llm/index.js";
import { REGISTRY, callTool, manifest } from "../tools.js";

const GOLDEN = new URL("../../docs/golden-queries.md", import.meta.url).pathname;

describe("evalrun parser", () => {
  it("parses the repo golden file", () => {
    const entries = parseGolden(GOLDEN);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const byQuery = Object.fromEntries(entries.map((e) => [e.query, e.expected]));
    expect(byQuery["PAY-981"]).toEqual(["jira:issue:PAY-981"]);
    expect(byQuery["how do payment retries work"]).toEqual(["confluence:page:12345"]);
  });

  it("handles multiple ids and ignores prose", () => {
    const dir = mkdtempSync(join(tmpdir(), "eil-golden-"));
    const path = join(dir, "g.md");
    writeFileSync(
      path,
      "# Golden\n\nprose\n\n- `retry policy` → confluence:page:1, obsidian:note:x — note\n- not an entry\n",
    );
    const entries = parseGolden(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.expected).toEqual(["confluence:page:1", "obsidian:note:x"]);
  });
});

describe("obsidian", () => {
  const makeVault = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "eil-vault-"));
    mkdirSync(join(dir, "payments"));
    mkdirSync(join(dir, ".obsidian"));
    writeFileSync(
      join(dir, "payments", "retry-policy.md"),
      "# Retry Policy Notes\n\nSee [[payments/parked-payments-runbook]] and PAY-981.\n",
    );
    writeFileSync(join(dir, ".obsidian", "config.md"), "internal");
    writeFileSync(join(dir, "inbox.md"), "no heading here\n");
    return dir;
  };

  it("normalizes notes with curated tier and links", () => {
    const docs = walkVault(makeVault());
    const ids = docs.map((d) => d.id);
    expect(ids).toContain("obsidian:note:payments/retry-policy");
    expect(ids).toContain("obsidian:note:inbox");
    expect(ids.some((i) => i.includes(".obsidian"))).toBe(false);

    const note = docs.find((d) => d.id.endsWith("retry-policy"))!;
    expect(note.title).toBe("Retry Policy Notes");
    expect(note.hierarchy).toEqual(["payments"]);
    expect(note.qualityTier).toBe("curated");
    expect(note.links).toContain("jira:issue:PAY-981");
    expect(note.links).toContain("obsidian:note:payments/parked-payments-runbook");

    const inbox = docs.find((d) => d.id.endsWith("inbox"))!;
    expect(inbox.title).toBe("inbox");
  });

  it("walks deterministically", () => {
    const vault = makeVault();
    expect(walkVault(vault).map((d) => d.id)).toEqual(walkVault(vault).map((d) => d.id));
  });
});

describe("llm", () => {
  const echoArgv = [process.execPath, "-e", "console.log(process.argv[1])"];

  it("cli provider round-trips and reports no usage", async () => {
    const echo = new CliProvider("echo", echoArgv);
    const result = await echo.complete("hello world");
    expect(result.text).toBe("hello world");
    expect(result.provider).toBe("echo");
    expect(result.promptTokens ?? null).toBeNull();
    expect(result.latencyMs).not.toBeNull();
  });

  it("cli provider prepends system", async () => {
    const echo = new CliProvider("echo", echoArgv);
    const result = await echo.complete("question", { system: "you are terse" });
    expect(result.text.startsWith("you are terse")).toBe(true);
  });

  it("cli provider raises on failure", async () => {
    const fail = new CliProvider("fail", [process.execPath, "-e", "process.exit(3)"]);
    await expect(fail.complete("x")).rejects.toThrow(/fail failed/);
  });

  it("registry selects and rejects", () => {
    delete process.env.EIL_LLM_PROVIDER;
    expect(getProvider().name).toBe("maas");
    expect(getProvider("amp").name).toBe("amp");
    expect(getProvider("copilot").name).toBe("copilot");
    process.env.EIL_LLM_PROVIDER = "amp";
    expect(getProvider().name).toBe("amp");
    delete process.env.EIL_LLM_PROVIDER;
    expect(() => getProvider("gpt")).toThrow(/unknown LLM provider/);
  });

  it("parseJsonReply tolerates fences", () => {
    expect(parseJsonReply('{"verdict": true}')).toEqual({ verdict: true });
    expect(parseJsonReply('```json\n{"verdict": true}\n```')).toEqual({ verdict: true });
    expect(parseJsonReply('Sure! Here you go: {"a": 1}')).toEqual({ a: 1 });
    expect(() => parseJsonReply("no json here")).toThrow();
  });
});

describe("tool registry (portability contract)", () => {
  it("exposes the five tools with discovery-ready specs", () => {
    expect(Object.keys(REGISTRY).sort()).toEqual([
      "expand",
      "fetch_logs",
      "get_doc",
      "search_code",
      "search_docs",
    ]);
    const m: any = manifest();
    expect(m.server).toBe("eil-knowledge");
    for (const tool of m.tools) {
      expect(tool.description.length).toBeGreaterThan(30);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("unknown tool returns error and catalog", async () => {
    const result: any = await callTool("nope", {});
    expect(result.error).toContain("unknown tool");
    expect(result.tools).toContain("search_docs");
  });

  it("invalid arguments return a clean error dict, before any DB connection", async () => {
    const result: any = await callTool("search_docs", { query: 123 });
    expect(result.error).toContain("invalid arguments for search_docs");
    expect(result.issues).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("123"); // no echo of caller values beyond field names
  });

  it("env-gated tools fail closed without a database", async () => {
    for (const v of ["EIL_BITBUCKET_URL", "EIL_BITBUCKET_TOKEN", "EIL_ELK_URL", "EIL_ELK_TOKEN"]) {
      delete process.env[v];
    }
    expect(((await callTool("search_code", { query: "x" })) as any).error).toContain(
      "not configured",
    );
    expect(((await callTool("fetch_logs", { query: "x" })) as any).error).toContain(
      "not configured",
    );
  });

  it("manifest CLI command emits valid JSON", () => {
    const out = execFileSync("pnpm", ["-s", "eil", "tools"], { encoding: "utf-8" });
    const m = JSON.parse(out);
    expect(m.server).toBe("eil-knowledge");
    expect(m.tools.map((t: any) => t.name).sort()).toEqual(Object.keys(REGISTRY).sort());
  });
});
