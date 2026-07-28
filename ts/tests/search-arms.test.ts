/**
 * Per-source retrieval arms.
 *
 * Once code is ingested alongside Confluence/Jira, a single undifferentiated
 * FTS pool lets code crowd prose out entirely. Two independent mechanisms:
 *
 *  1. RANKING. ts_rank has no IDF and no tf saturation, so a long, term-
 *     repetitive code chunk outranks a short, densely on-topic doc. Measured on
 *     a real corpus: a test file scored 0.2519 against the retry-policy page's
 *     0.2424, on 6 term hits in 1702 chars versus 5 in 252. Length
 *     normalization alone does NOT fix this — with a couple more incidental
 *     mentions the code chunk wins at every normalization setting.
 *
 *  2. CANDIDATE STARVATION. The pool was capped in CHUNKS, not docs, so a few
 *     large code files could consume it before any prose was considered.
 *
 * The fix is structural rather than a scoring tweak: rank each source class in
 * its own arm and fuse with RRF. Because RRF is rank-based, a code chunk with
 * an inflated ts_rank can only ever outrank OTHER CODE — it can never evict
 * prose from the result set. Arm weights come from the existing query router,
 * so an identifier query still favours code.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalDoc } from "../contracts/models.js";
import { type Db, connect, migrate } from "../db.js";
import { type Viewer, searchDocs } from "../search.js";
import { upsertDocument } from "../store.js";

const ME = userInfo().username;
const VIEWER: Viewer = { principal: ME, groups: [] };

let dataDir: string;
let client: Db;
let savedUrl: string | undefined;

const doc = (id: string, source: string, title: string, body: string) =>
  CanonicalDoc.parse({ id, source, title, body, aclGroups: [], links: [] });

/** Long, term-repetitive, and only incidentally about the topic — like a real
 *  code line-window whose fixtures happen to mention retries. */
const FILLER =
  "const sample = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa';";

const codeBody = (n: number) =>
  [
    `it("converts a Retry table ${n}", () => { expect(convert(html)).toContain("Backoff"); });`,
    `it("keeps the Retry heading and Backoff column ${n}", () => {`,
    '  const rows = parse(fixture); expect(rows[0].retry_key).toBe("a");',
    '  expect(rows[1].retry_key).toBe("b"); expect(rows[2].retry_key).toBe("c");',
    "});",
    ...Array(9).fill(FILLER),
  ].join("\n");

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "eil-arms-"));
  savedUrl = process.env.EIL_DATABASE_URL;
  process.env.EIL_DATABASE_URL = `pglite://${dataDir}`;
  client = await connect();
  await migrate(client);

  await upsertDocument(
    client,
    doc(
      "confluence:page:1",
      "confluence",
      "Payment Retry Policy",
      "Retries use exponential backoff starting at 30 seconds, doubling up to a maximum of " +
        "four attempts. After the final retry the payment is parked and an operator is paged.",
    ),
  );
  await upsertDocument(
    client,
    doc(
      "jira:issue:CHK-4",
      "jira",
      "Parked payments not alerting after retry exhaustion",
      "When the retry budget is exhausted the payment parks silently and no backoff alert fires.",
    ),
  );
  // enough code to swamp a chunk-capped candidate pool
  for (let i = 0; i < 12; i++) {
    await upsertDocument(
      client,
      doc(`code:repo:ts/tests/f${i}.test.ts`, "code", `f${i}.test.ts`, codeBody(i)),
    );
  }
  // one prose and one code doc that BOTH mention an identifier, to prove the
  // weighting flips rather than merely suppressing code
  await upsertDocument(
    client,
    doc(
      "confluence:page:2",
      "confluence",
      "Naming conventions",
      "Handlers are named after their queue, for example retryHandler or parkHandler.",
    ),
  );
  await upsertDocument(
    client,
    doc(
      "code:repo:ts/retryHandler.ts",
      "code",
      "ts/retryHandler.ts",
      "export function retryHandler(job) { return schedule(job); } // retryHandler entry point",
    ),
  );
});

afterAll(async () => {
  await client?.end();
  if (savedUrl === undefined) delete process.env.EIL_DATABASE_URL;
  else process.env.EIL_DATABASE_URL = savedUrl;
  rmSync(dataDir, { recursive: true, force: true });
});

const ids = async (q: string, limit = 8) =>
  ((await searchDocs(client, VIEWER, q, limit)) as any).results.map((r: any) => r.id) as string[];

describe("per-source arms", () => {
  it("keeps prose on top for a natural-language question, despite 12 code docs", async () => {
    const got = await ids("retry backoff");
    expect(got.length).toBeGreaterThan(0);
    expect(got[0]).toBe("confluence:page:1");
  });

  it("never lets code evict prose from the result set", async () => {
    const got = await ids("retry backoff");
    expect(got).toContain("confluence:page:1");
    expect(got).toContain("jira:issue:CHK-4");
  });

  it("still favours code when the router says the query is a symbol", async () => {
    // classify("retryHandler") -> symbol, so the code arm outweighs prose
    const got = await ids("retryHandler");
    expect(got).toContain("code:repo:ts/retryHandler.ts");
    expect(got.indexOf("code:repo:ts/retryHandler.ts")).toBeLessThan(
      got.indexOf("confluence:page:2") === -1
        ? Number.POSITIVE_INFINITY
        : got.indexOf("confluence:page:2"),
    );
  });

  it("reports which arms actually ran", async () => {
    const res: any = await searchDocs(client, VIEWER, "retry backoff", 8);
    expect(res.executor).toContain("fts_prose");
    expect(res.executor).toContain("fts_code");
  });
});
