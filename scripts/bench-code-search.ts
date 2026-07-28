#!/usr/bin/env tsx
/** Repeatable no-model benchmark for the deterministic structural extractor. */
import { performance } from "node:perf_hooks";
import { extractCodeIndex } from "../ts/ingest/codeindex.js";

const corpus = [
  [
    "src/retry.ts",
    'export function retryPayment(attempt: number) { return "retry"; }\nimport { Client } from "./client";',
  ],
  ["app/retry.py", 'def retry_payment(attempt):\n    return "retry"\n'],
  ["retry/retry.go", 'package retry\nfunc RetryPayment() string { return "retry" }\n'],
] as const;
const started = performance.now();
const results = corpus.map(([path, body]) => ({
  path,
  entries: extractCodeIndex(path, body).length,
}));
const elapsedMs = performance.now() - started;
const symbols = corpus.flatMap(([path, body]) =>
  extractCodeIndex(path, body)
    .filter((e) => e.kind === "symbol")
    .map((e) => `${path}:${e.rawValue}`),
);
if (!symbols.some((s) => /retryPayment/i.test(s))) throw new Error("golden symbol not indexed");
console.log(
  JSON.stringify(
    {
      executor: "code_index",
      files: corpus.length,
      entries: results.reduce((n, r) => n + r.entries, 0),
      elapsedMs: Math.round(elapsedMs * 1000) / 1000,
      symbols,
      results,
    },
    null,
    2,
  ),
);
