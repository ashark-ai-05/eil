/**
 * Metrics-view verification: seed facts in deterministic loops, recompute
 * every expected aggregate independently, assert the SQL views agree.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, connect, migrationFiles } from "../db.js";
import { record } from "../evalrun.js";

const AUDIT_PLAN: Array<[string, string, number, number]> = [
  ["krunal", "search_docs", 3, 6],
  ["krunal", "search_docs", 0, 2],
  ["krunal", "get_doc", 1, 5],
  ["krunal", "expand", 4, 3],
  ["asha", "search_docs", 2, 4],
  ["asha", "search_code", 0, 1],
  ["asha", "get_doc", 1, 2],
];
// Deliberately reuses "krunal"/"search_docs" from AUDIT_PLAN — a key
// collision across tenants would be silently merged if a view's GROUP BY
// forgot tenant, so this is the case that actually tests isolation.
const TENANT_B_AUDIT_PLAN: Array<[string, string, number, number]> = [
  ["krunal", "search_docs", 5, 3],
  ["priya", "get_doc", 2, 2],
];
const DAYS = ["2026-07-25", "2026-07-26"];
const LLM_PLAN: Array<
  [string, string | null, string, number | null, number | null, number, boolean, number]
> = [
  ["maas", "nemotron", "pr-review", 900, 120, 800, true, 4],
  ["maas", "nemotron", "pr-review", 900, 0, 100, false, 1],
  ["amp", null, "incident-triage", null, null, 30_000, true, 2],
];

let client: Db;
let available = true;
try {
  const probe = await connect("postgres");
  await probe.end();
} catch {
  available = false;
}

async function admin(sqlText: string): Promise<void> {
  const a = await connect("postgres");
  try {
    await a.query(sqlText);
  } finally {
    await a.end();
  }
}

beforeAll(async () => {
  try {
    await admin("DROP DATABASE IF EXISTS eil_ts_metrics");
    await admin("CREATE DATABASE eil_ts_metrics");
  } catch {
    available = false;
    return;
  }
  client = await connect("eil_ts_metrics");
  const dbCheck = await client.query("SELECT current_database() AS db");
  if (dbCheck.rows[0].db !== "eil_ts_metrics")
    throw new Error(`wrong database: ${dbCheck.rows[0].db}`);
  for (const { sql } of migrationFiles()) await client.query(sql);
  for (const day of DAYS) {
    for (const [principal, tool, resultCount, reps] of AUDIT_PLAN) {
      for (let i = 0; i < reps; i++) {
        await client.query(
          "INSERT INTO audit_log (at, principal, tool, args, result_count)" +
            " VALUES ($1::date + interval '1 hour' * $2, $3, $4, $5, $6)",
          [day, i, principal, tool, JSON.stringify({ seed: i }), resultCount],
        );
      }
    }
    for (const [provider, model, caller, pt, ct, lat, ok, reps] of LLM_PLAN) {
      for (let i = 0; i < reps; i++) {
        await client.query(
          "INSERT INTO llm_calls (at, provider, model, caller, prompt_tokens," +
            " completion_tokens, latency_ms, ok)" +
            " VALUES ($1::date + interval '1 minute' * $2, $3, $4, $5, $6, $7, $8, $9)",
          [day, i, provider, model, caller, pt, ct, lat, ok],
        );
      }
    }
  }
  await client.query(
    "INSERT INTO sync_cursors (source, cursor) VALUES ('confluence', '2026-07-26T00:00:00')",
  );
  await record(client, {
    k: 10,
    mean_recall: 0.5,
    queries: [
      { query: "q1", recall: 0.0, expected: ["doc:x"], missing: ["doc:x"] },
      { query: "q2", recall: 1.0, expected: ["doc:y"], missing: [] },
    ],
  });
  await record(client, {
    k: 10,
    mean_recall: 1.0,
    queries: [
      { query: "q1", recall: 1.0, expected: ["doc:x"], missing: [] },
      { query: "q2", recall: 1.0, expected: ["doc:y"], missing: [] },
    ],
  });
  await client.query(
    "INSERT INTO metrics.usage_facts (day, principal, tool, source, quantity, unit, cost_usd)" +
      " VALUES ('2026-07-25', 'krunal', 'amp', 'amp-admin-api', 42.5, 'credits', 21.25)," +
      "        ('2026-07-25', 'asha', 'maas', 'gateway', 1.2345, 'usd', 1.2345)",
  );

  // A second tenant, seeded on the same day with overlapping principal/tool
  // names on purpose — the isolation tests below prove the views separate by
  // tenant rather than by coincidence of distinct labels.
  for (const [principal, tool, resultCount, reps] of TENANT_B_AUDIT_PLAN) {
    for (let i = 0; i < reps; i++) {
      await client.query(
        "INSERT INTO audit_log (at, tenant, principal, tool, args, result_count)" +
          " VALUES ($1::date + interval '1 hour' * $2, 'tenant-b', $3, $4, $5, $6)",
        [DAYS[0], i, principal, tool, JSON.stringify({ seed: i }), resultCount],
      );
    }
  }
  await client.query(
    "INSERT INTO metrics.usage_facts (day, tenant, principal, tool, source, quantity, unit, cost_usd)" +
      " VALUES ('2026-07-25', 'tenant-b', 'krunal', 'amp', 'amp-admin-api', 9, 'credits', 4.5)",
  );
});

afterAll(async () => {
  if (!available) return;
  await client.end();
  await admin("DROP DATABASE eil_ts_metrics WITH (FORCE)");
});

function expectedCalls(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [principal, tool, , reps] of AUDIT_PLAN) {
    const key = `${principal}|${tool}`;
    out.set(key, (out.get(key) ?? 0) + reps);
  }
  return out;
}

describe.skipIf(!available)("metrics views", () => {
  it("vw_tool_calls matches an independent recount", async () => {
    for (const day of DAYS) {
      const res = await client.query(
        "SELECT principal, tool, calls::int FROM metrics.vw_tool_calls WHERE day = $1 AND tenant = 'default'",
        [day],
      );
      const got = new Map(res.rows.map((r) => [`${r.principal}|${r.tool}`, r.calls]));
      expect(got).toEqual(expectedCalls());
    }
  });

  it("vw_zero_results has exact rates", async () => {
    const res = await client.query(
      "SELECT tool, calls::int, zero_calls::int, zero_rate FROM metrics.vw_zero_results" +
        " WHERE day = $1 AND tenant = 'default'",
      [DAYS[0]],
    );
    const got = Object.fromEntries(
      res.rows.map((r) => [r.tool, [r.calls, r.zero_calls, Number(r.zero_rate)]]),
    );
    expect(got.search_docs).toEqual([12, 2, Math.round((2 / 12) * 1000) / 1000]);
    expect(got.search_code).toEqual([1, 1, 1.0]);
  });

  it("vw_two_phase ratio", async () => {
    const res = await client.query(
      "SELECT searches::int, fetches::int, ratio FROM metrics.vw_two_phase" +
        " WHERE day = $1 AND tenant = 'default'",
      [DAYS[1]],
    );
    const row = res.rows[0];
    expect(row.searches).toBe(13);
    expect(row.fetches).toBe(7);
    expect(Number(row.ratio)).toBe(Math.round((7 / 13) * 1000) / 1000);
  });

  it("vw_llm_calls aggregates", async () => {
    const res = await client.query(
      "SELECT provider, calls::int, prompt_tokens::int, failures::int, avg_latency_ms" +
        " FROM metrics.vw_llm_calls WHERE day = $1 AND caller = 'pr-review'",
      [DAYS[0]],
    );
    expect(res.rows).toHaveLength(1);
    const r = res.rows[0];
    expect([r.provider, r.calls, r.prompt_tokens, r.failures]).toEqual(["maas", 5, 4500, 1]);
    expect(r.avg_latency_ms).toBe(Math.floor((800 * 4 + 100) / 5));
  });

  it("vw_eval_trend orders runs and keeps misses", async () => {
    const res = await client.query(
      "SELECT mean_recall, queries::int FROM metrics.vw_eval_trend ORDER BY at",
    );
    expect(res.rows.map((r) => Number(r.mean_recall))).toEqual([0.5, 1.0]);
    expect(res.rows.every((r) => r.queries === 2)).toBe(true);
    const misses = await client.query("SELECT misses FROM metrics.eval_runs ORDER BY at LIMIT 1");
    expect(misses.rows[0].misses).toEqual([{ query: "q1", missing: ["doc:x"] }]);
  });

  it("vw_connector_health reports age", async () => {
    const res = await client.query(
      "SELECT source, age_hours FROM metrics.vw_connector_health WHERE source = 'confluence'",
    );
    expect(res.rows).toHaveLength(1);
    expect(Number(res.rows[0].age_hours)).toBeGreaterThanOrEqual(0);
  });

  it("vw_spend_daily preserves native units", async () => {
    const res = await client.query(
      "SELECT tool, unit, quantity, cost_usd FROM metrics.vw_spend_daily" +
        " WHERE tenant = 'default' ORDER BY tool",
    );
    const got = Object.fromEntries(
      res.rows.map((r) => [r.tool, [r.unit, Number(r.quantity), Number(r.cost_usd)]]),
    );
    expect(got.amp).toEqual(["credits", 42.5, 21.25]);
    expect(got.maas).toEqual(["usd", 1.2345, 1.2345]);
  });

  it("tenant scoping isolates audit and spend metrics", async () => {
    // Same day, overlapping principal/tool labels, different tenant — proves
    // the views group by tenant rather than merging on label collision.
    const calls = await client.query(
      "SELECT principal, tool, calls::int FROM metrics.vw_tool_calls" +
        " WHERE day = $1 AND tenant = 'tenant-b' ORDER BY principal",
      [DAYS[0]],
    );
    expect(calls.rows).toEqual([
      { principal: "krunal", tool: "search_docs", calls: 3 },
      { principal: "priya", tool: "get_doc", calls: 2 },
    ]);

    // tenant-b's rows must not have leaked into 'default's krunal/search_docs
    // count for the same day — expectedCalls() already excludes tenant-b.
    const defaultCalls = await client.query(
      "SELECT calls::int FROM metrics.vw_tool_calls" +
        " WHERE day = $1 AND tenant = 'default' AND principal = 'krunal' AND tool = 'search_docs'",
      [DAYS[0]],
    );
    expect(defaultCalls.rows[0]!.calls).toBe(expectedCalls().get("krunal|search_docs"));

    const zeroResults = await client.query(
      "SELECT calls::int, zero_calls::int FROM metrics.vw_zero_results" +
        " WHERE day = $1 AND tenant = 'tenant-b' AND tool = 'search_docs'",
      [DAYS[0]],
    );
    expect(zeroResults.rows[0]).toEqual({ calls: 3, zero_calls: 0 });

    const twoPhase = await client.query(
      "SELECT searches::int, fetches::int FROM metrics.vw_two_phase" +
        " WHERE day = $1 AND tenant = 'tenant-b'",
      [DAYS[0]],
    );
    expect(twoPhase.rows[0]).toEqual({ searches: 3, fetches: 2 });

    const spend = await client.query(
      "SELECT unit, quantity, cost_usd FROM metrics.vw_spend_daily" +
        " WHERE tenant = 'tenant-b' AND tool = 'amp'",
    );
    const spendRow = spend.rows[0]!;
    expect([spendRow.unit, Number(spendRow.quantity), Number(spendRow.cost_usd)]).toEqual([
      "credits",
      9,
      4.5,
    ]);
  });

  it("report renders from the views", async () => {
    const { collect, render } = await import("../report.js");
    const html = render(await collect(client), "test");
    expect(html).toContain("MCP calls by tool");
    expect(html).toContain("<svg");
    expect(html).toContain("search_docs");
    expect(html).toContain("0.5");
  });
});
