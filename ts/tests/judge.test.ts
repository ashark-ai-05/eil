/**
 * The judging loop. Its job is to remove the friction that kept
 * docs/golden-queries.md at two entries — so the round-trip must be lossless,
 * and a half-filled worksheet must be safe to import.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
import { type Db, connect, migrate } from "../db.js";
import { runEval } from "../eval/harness.js";
import {
  type PoolItem,
  applyJudgments,
  buildPool,
  exportPool,
  judgePrompt,
  judgeWithLlm,
  parseJudgments,
} from "../eval/judge.js";
import type { Provider } from "../llm/index.js";
import { type Viewer, viewerFromAuthenticatedClaims } from "../search.js";
import { upsertDocument } from "../store.js";

let client: Db;
let dir: string;
let saved: string | undefined;
const VIEWER: Viewer = viewerFromAuthenticatedClaims({
  principal: userInfo().username,
  groups: [],
  tenant: "default",
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eil-judge-"));
  saved = process.env.EIL_DATABASE_URL;
  process.env.EIL_DATABASE_URL = `pglite://${dir}`;
  client = await connect();
  await migrate(client);
  for (const [id, title, body] of [
    ["j1", "Payment Retry Policy", "Retries use exponential backoff with a cap of 30 seconds."],
    ["j2", "Refund Policy", "Refunds are issued within five business days."],
    ["j3", "Dunning", "Dunning emails go out on days 1, 3 and 7 after a failed charge."],
  ] as const) {
    await upsertDocument(
      client,
      CanonicalDoc.parse({
        id: `confluence:page:${id}`,
        source: "confluence",
        title,
        body,
        aclGroups: [],
      }),
    );
  }
  await client.query(
    "INSERT INTO eval_queries (query, tenant, origin) VALUES ($1, 'default', 'authored')",
    ["how do payment retries back off"],
  );
});
afterAll(async () => {
  await client.end();
  if (saved === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("pooling", () => {
  it("pools what the PRODUCTION retriever actually returns", async () => {
    const pool = await buildPool(client, VIEWER, 20);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool[0]!.query).toBe("how do payment retries back off");
    expect(pool[0]!.docId).toMatch(/^confluence:page:/);
  });

  it("never re-offers a pair that is already judged", async () => {
    const before = await buildPool(client, VIEWER, 20);
    await applyJudgments(client, [{ ...before[0]!, grade: 3 }], "tester");
    const after = await buildPool(client, VIEWER, 20);
    expect(after.map((p) => p.docId)).not.toContain(before[0]!.docId);
    expect(after.length).toBe(before.length - 1);
  });
});

describe("worksheet round-trip", () => {
  const pool: PoolItem[] = [
    { queryId: 7, query: "retries", docId: "confluence:page:a", title: "A", snippet: "sa" },
    { queryId: 7, query: "retries", docId: "confluence:page:b", title: "B", snippet: "sb" },
    { queryId: 9, query: "refunds", docId: "confluence:page:c", title: "C", snippet: "sc" },
  ];

  it("survives export -> fill -> parse without losing a pair", () => {
    const filled = exportPool(pool)
      .replace("grade: ?", "grade: 3")
      .replace("grade: ?", "grade: 0")
      .replace("grade: ?", "grade: 2");
    expect(parseJudgments(filled)).toEqual([
      { queryId: 7, docId: "confluence:page:a", grade: 3 },
      { queryId: 7, docId: "confluence:page:b", grade: 0 },
      { queryId: 9, docId: "confluence:page:c", grade: 2 },
    ]);
  });

  it("SKIPS unfilled pairs rather than defaulting them", () => {
    // Guessing a grade would silently poison the collection, and the poisoned
    // entry would be indistinguishable from a real judgment forever.
    const half = exportPool(pool).replace("grade: ?", "grade: 1");
    const got = parseJudgments(half);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ queryId: 7, docId: "confluence:page:a", grade: 1 });
  });

  it("refuses a file that is not a judgments worksheet", () => {
    expect(() => parseJudgments("# some other markdown\n")).toThrow("not an eil judgments file");
  });

  it("keeps grade 0 — 'judged and not relevant' is what makes judged@k meaningful", () => {
    const zeroed = exportPool([pool[0]!]).replace("grade: ?", "grade: 0");
    expect(parseJudgments(zeroed)).toEqual([{ queryId: 7, docId: "confluence:page:a", grade: 0 }]);
  });
});

describe("model judging", () => {
  const stub = (reply: (p: string) => string): Provider => ({
    name: "stub",
    async complete(prompt: string) {
      return { text: reply(prompt), provider: "stub" };
    },
  });

  it("grades a pool and writes the judgments", async () => {
    const pool = await buildPool(client, VIEWER, 20);
    const { judgments, failed } = await judgeWithLlm(
      pool,
      stub(() => '{"grade": 2}'),
    );
    expect(failed).toBe(0);
    expect(judgments).toHaveLength(pool.length);
    expect(await applyJudgments(client, judgments, "llm:stub")).toBe(pool.length);
  });

  it("SKIPS a pair the model answers badly rather than defaulting it", async () => {
    const pool: PoolItem[] = [
      { queryId: 1, query: "q", docId: "d1", title: "t", snippet: "s" },
      { queryId: 1, query: "q", docId: "d2", title: "t", snippet: "s" },
    ];
    let n = 0;
    const { judgments, failed } = await judgeWithLlm(
      pool,
      stub(() => (n++ === 0 ? "I cannot answer that" : '{"grade": 9}')), // unparseable, then out of range
    );
    expect(judgments).toHaveLength(0);
    expect(failed).toBe(2);
  });

  it("puts the graded scale in the prompt, so a later judge uses the same one", () => {
    const p = judgePrompt("how do retries work", "Retry Policy", "backoff");
    expect(p).toContain("how do retries work");
    expect(p).toContain("0 —");
    expect(p).toContain("3 —");
    expect(p).toContain('{"grade":');
  });
});

describe("the loop closes", () => {
  it("mine -> pool -> judge -> score produces a real number", async () => {
    const before = await runEval(client, VIEWER);
    const pool = await buildPool(client, VIEWER, 20);
    if (pool.length > 0) {
      await applyJudgments(
        client,
        pool.map((p) => ({ queryId: p.queryId, docId: p.docId, grade: 1 })),
        "tester",
      );
    }
    const after = await runEval(client, VIEWER);
    expect(after.judged).toBeGreaterThanOrEqual(before.judged);
    expect(Number.isNaN(after.ndcg10)).toBe(false); // was NaN before any judgment
    expect(after.judged10).toBeGreaterThan(0);
  });
});
