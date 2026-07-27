/**
 * Golden-query eval: recall@k over docs/golden-queries.md, run through the
 * real retrieval path. Every run is recorded (with git sha) for the trend.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Db } from "./db.js";
import { type Viewer, searchDocs } from "./search.js";

const ENTRY_RE = /^- `(.+?)` → ([^—\n]+)/;

export interface GoldenEntry {
  query: string;
  expected: string[];
}

export function parseGolden(path: string): GoldenEntry[] {
  const entries: GoldenEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = ENTRY_RE.exec(line.trim());
    if (m) {
      const expected = m[2]!
        .split(",")
        .map((i) => i.trim())
        .filter(Boolean);
      entries.push({ query: m[1]!, expected });
    }
  }
  return entries;
}

function retrievedIds(result: Record<string, any>, k: number): string[] {
  if ("entity" in result) {
    const ids = result.entity ? [result.entity.id as string] : [];
    ids.push(...(result.linked ?? []).map((e: any) => e.id as string));
    return ids.slice(0, k);
  }
  return (result.results ?? []).map((r: any) => r.id as string).slice(0, k);
}

export interface EvalReport {
  k: number;
  mean_recall: number;
  queries: Array<{ query: string; recall: number; expected: string[]; missing: string[] }>;
}

export async function run(
  client: Db,
  viewer: Viewer,
  entries: GoldenEntry[],
  k = 10,
): Promise<EvalReport> {
  const perQuery = [];
  for (const entry of entries) {
    const got = retrievedIds(await searchDocs(client, viewer, entry.query, k), k);
    const missing = entry.expected.filter((e) => !got.includes(e));
    perQuery.push({
      query: entry.query,
      recall:
        entry.expected.length > 0
          ? (entry.expected.length - missing.length) / entry.expected.length
          : 1.0,
      expected: entry.expected,
      missing,
    });
  }
  const mean =
    perQuery.length > 0 ? perQuery.reduce((s, q) => s + q.recall, 0) / perQuery.length : 0.0;
  return { k, mean_recall: Math.round(mean * 1e4) / 1e4, queries: perQuery };
}

export function gitSha(): string {
  try {
    return (
      execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim() || "unknown"
    );
  } catch {
    return "unknown";
  }
}

/** Persist a run into metrics.eval_runs — trend, not snapshot. */
export async function record(client: Db, report: EvalReport): Promise<void> {
  const misses = report.queries
    .filter((q) => q.missing.length > 0)
    .map((q) => ({ query: q.query, missing: q.missing }));
  await client.query(
    "INSERT INTO metrics.eval_runs (git_sha, k, mean_recall, queries, misses)" +
      " VALUES ($1, $2, $3, $4, $5)",
    [gitSha(), report.k, report.mean_recall, report.queries.length, JSON.stringify(misses)],
  );
}
