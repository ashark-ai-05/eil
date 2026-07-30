/**
 * LLM provider abstraction — every model call in EIL goes through this.
 * Backend is config, not code: maas (OpenAI-compatible via the LiteLLM
 * gateway), headless amp, or the copilot CLI. Per-workflow tiering lives in
 * provider selection, driven by eval data.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { Db } from "../db.js";

const execFileAsync = promisify(execFile);

export interface LLMResult {
  text: string;
  provider: string;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
}

export interface CompleteOptions {
  system?: string;
  model?: string;
  maxTokens?: number;
}

export interface Provider {
  name: string;
  complete(prompt: string, opts?: CompleteOptions): Promise<LLMResult>;
}

/** OpenAI-compatible API provider — the default path, via the LiteLLM gateway. */
export class MaasProvider implements Provider {
  name = "maas";
  private baseUrl = process.env.EIL_MAAS_BASE_URL ?? "http://localhost:4000";
  private apiKey = process.env.EIL_MAAS_API_KEY ?? "";
  private defaultModel = process.env.EIL_MAAS_MODEL ?? "nemotron";

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<LLMResult> {
    const model = opts.model ?? this.defaultModel;
    const started = performance.now();
    const messages = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: prompt },
    ];
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 1024 }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`maas -> ${res.status}`);
    const data: any = await res.json();
    return {
      text: data.choices[0].message.content,
      provider: this.name,
      model: data.model ?? model,
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

/**
 * CLI-backed providers: headless Amp and Copilot. Argv is env-configurable
 * (EIL_AMP_ARGV, EIL_COPILOT_ARGV) since flags vary by version. No token
 * usage reported — cost lands via the F1 collectors; counts/latency via
 * logCall().
 */
export class CliProvider implements Provider {
  constructor(
    public name: string,
    private argv: string[],
    private timeoutMs = 600_000,
  ) {}

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<LLMResult> {
    const fullPrompt = opts.system ? `${opts.system}\n\n${prompt}` : prompt;
    const started = performance.now();
    try {
      // async execFile: a long-running Amp/Copilot subprocess must never
      // block the MCP server's event loop.
      const { stdout } = await execFileAsync(this.argv[0]!, [...this.argv.slice(1), fullPrompt], {
        encoding: "utf-8",
        timeout: this.timeoutMs,
      });
      return {
        text: stdout.trim(),
        provider: this.name,
        model: opts.model ?? null,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err: any) {
      const stderr = String(err.stderr ?? "").slice(0, 500);
      throw new Error(`${this.name} failed: ${stderr || err.message}`);
    }
  }
}

/**
 * Replays a recorded reply. Makes the elaboration loop deterministic in tests
 * and rehearsal, and lets the whole pipeline run on a machine where neither amp
 * nor copilot is installed. EIL_LLM_FIXTURE points at a JSON file mapping a
 * prompt hash to a reply; a `default` entry answers anything unrecorded.
 */
export class FixtureProvider implements Provider {
  name = "fixture";
  constructor(private replies: Record<string, string>) {}

  async complete(prompt: string, _opts: CompleteOptions = {}): Promise<LLMResult> {
    const key = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    const text = this.replies[key] ?? this.replies.default;
    if (text === undefined) throw new Error(`fixture provider: no reply for prompt ${key}`);
    return { text, provider: this.name, model: "fixture", latencyMs: 0 };
  }
}

const split = (s: string) => s.split(/\s+/).filter(Boolean);

/** Read once, at selection time: a fixture that is missing or malformed must
 *  fail loudly here rather than as a mystery empty reply mid-run. */
function loadFixture(): Record<string, string> {
  const path = process.env.EIL_LLM_FIXTURE;
  if (!path) throw new Error("fixture provider: set EIL_LLM_FIXTURE to a JSON file of replies");
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  } catch (err: any) {
    throw new Error(`fixture provider: cannot load ${path}: ${err?.message ?? String(err)}`);
  }
}

/** Per-call name > EIL_LLM_PROVIDER env > maas default. */
export function getProvider(name?: string): Provider {
  const selected = name ?? process.env.EIL_LLM_PROVIDER ?? "maas";
  switch (selected) {
    case "maas":
      return new MaasProvider();
    case "amp":
      return new CliProvider("amp", split(process.env.EIL_AMP_ARGV ?? "amp -x"));
    case "copilot":
      return new CliProvider("copilot", split(process.env.EIL_COPILOT_ARGV ?? "copilot -p"));
    case "fixture":
      return new FixtureProvider(loadFixture());
    default:
      throw new Error(
        `unknown LLM provider: '${selected}' (expected maas | amp | copilot | fixture)`,
      );
  }
}

/** Local usage record — the only telemetry for CLI backends. */
export async function logCall(
  client: Db,
  caller: string,
  result: LLMResult,
  ok = true,
): Promise<void> {
  await client.query(
    "INSERT INTO llm_calls (provider, model, caller, prompt_tokens, completion_tokens," +
      " latency_ms, ok) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [
      result.provider,
      result.model ?? null,
      caller,
      result.promptTokens ?? null,
      result.completionTokens ?? null,
      result.latencyMs ?? null,
      ok,
    ],
  );
}

/** Tolerant JSON extraction for structured-output judgment steps. */
export function parseJsonReply(text: string): Record<string, unknown> {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.split("```")[1] ?? "";
    t = t.replace(/^json/, "").trim();
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(t.slice(start, end + 1));
}
