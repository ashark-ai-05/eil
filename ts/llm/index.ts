/**
 * LLM provider abstraction — every model call in EIL goes through this.
 * Backend is config, not code: maas (OpenAI-compatible via the LiteLLM
 * gateway), headless amp, or the copilot CLI. Per-workflow tiering lives in
 * provider selection, driven by eval data.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Db } from "../db.js";

const execFileAsync = promisify(execFile);

export interface LLMResult {
  text: string;
  /** what actually produced the text — on a replay, the provider that produced
   *  the RECORDING, never the literal string "fixture" */
  provider: string;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
  /** absent means "live": the provider named above was called just now.
   *  "replay" means the text came out of a recorded pack. */
  provenance?: "live" | "replay";
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

/** The key a reply is filed under: the sha256 prefix of the exact prompt. */
export const promptKey = (prompt: string): string =>
  createHash("sha256").update(prompt).digest("hex").slice(0, 16);

/** One recorded reply, with the latency the call ACTUALLY took when recorded. */
export interface RecordedReply {
  text: string;
  latencyMs?: number;
}

/**
 * A recorded model run. The provenance block is not decoration: a replayed run
 * has to be able to say what produced its judgments and when, or a replay
 * becomes indistinguishable from a live call — which is the one thing this
 * project exists to stop.
 */
export interface ReplayPack {
  recordedAt: string;
  /** what actually produced these replies — a provider name, or a plain-English
   *  description when no model was called at all */
  provider: string;
  model: string | null;
  /** free text: why this pack exists, and anything a reader must not mistake */
  note: string;
  replies: Record<string, RecordedReply>;
}

/**
 * The old shape — a flat `Record<string, string>` of hash to reply — is still
 * accepted, so packs written before provenance existed keep replaying. It
 * carries no provenance to report, so it reports itself as a fixture with no
 * model and no recorded timing, which is exactly what it is.
 */
export function normalisePack(raw: unknown): ReplayPack {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rich = obj.replies !== null && typeof obj.replies === "object";
  const entries = (rich ? obj.replies : obj) as Record<string, unknown>;
  const replies: Record<string, RecordedReply> = {};
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (typeof value === "string") {
      replies[key] = { text: value };
      continue;
    }
    const v = (value ?? {}) as Record<string, unknown>;
    if (typeof v.text !== "string") continue;
    replies[key] = {
      text: v.text,
      ...(typeof v.latencyMs === "number" ? { latencyMs: v.latencyMs } : {}),
    };
  }
  return {
    recordedAt: typeof obj.recordedAt === "string" ? obj.recordedAt : "",
    provider: typeof obj.provider === "string" ? obj.provider : "fixture",
    model: typeof obj.model === "string" ? obj.model : null,
    note: typeof obj.note === "string" ? obj.note : "",
    replies,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Replays a recorded run. Makes the elaboration loop deterministic in tests and
 * rehearsal, and lets the whole pipeline run on a machine where neither amp nor
 * copilot is installed. EIL_LLM_FIXTURE points at a pack; a `default` entry
 * answers anything unrecorded.
 *
 * Two things it deliberately does NOT do:
 *
 *  - it does not claim to be the producer. The result carries the PACK's
 *    provider and model, so `logCall()` records what actually produced the
 *    reply, and `provenance: "replay"` records that it was replayed rather than
 *    called. A replay that reported itself as a live call would be a lie the
 *    ledger could not later detect.
 *  - it does not return instantly. It sleeps the latency the recorded call
 *    really took, so a replayed run has the rhythm of the run it came from.
 *    That is REPRODUCING recorded timing, not inventing plausible timing: a
 *    pack with no recorded latency sleeps not at all.
 */
export class FixtureProvider implements Provider {
  name = "fixture";
  private pack: ReplayPack;

  constructor(replies: Record<string, string> | ReplayPack) {
    this.pack = normalisePack(replies);
  }

  /** The provenance the pack declares — for callers that must report it. */
  get provenance(): ReplayPack {
    return this.pack;
  }

  async complete(prompt: string, _opts: CompleteOptions = {}): Promise<LLMResult> {
    const key = promptKey(prompt);
    const reply = this.pack.replies[key] ?? this.pack.replies.default;
    if (reply === undefined) throw new Error(`fixture provider: no reply for prompt ${key}`);
    const latencyMs = reply.latencyMs ?? 0;
    if (latencyMs > 0) await sleep(latencyMs);
    return {
      text: reply.text,
      provider: this.pack.provider,
      model: this.pack.model,
      latencyMs,
      provenance: "replay",
    };
  }
}

/**
 * Wraps ANY provider and writes a replay pack as the run proceeds — the prompt
 * hash, the reply, and the latency the call really took.
 *
 * Written after every call rather than at the end, so a run that dies half way
 * still leaves a usable pack of what it got through. The provenance block is
 * taken from the results themselves, so recording a replay re-records the
 * ORIGINAL producer rather than laundering it into a new one.
 */
export class RecordingProvider implements Provider {
  name: string;
  private pack: ReplayPack;

  constructor(
    private inner: Provider,
    private path: string,
    note = "",
  ) {
    this.name = inner.name;
    this.pack = {
      recordedAt: new Date().toISOString(),
      provider: inner.name,
      model: null,
      note,
      replies: {},
    };
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<LLMResult> {
    const started = performance.now();
    const result = await this.inner.complete(prompt, opts);
    const measured = Math.round(performance.now() - started);
    this.pack.provider = result.provider;
    if (result.model) this.pack.model = result.model;
    this.pack.replies[promptKey(prompt)] = {
      text: result.text,
      // The measured wall time, never the provider's own claim about itself.
      latencyMs: measured,
    };
    this.flush();
    return result;
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(this.pack, null, 2)}\n`, "utf-8");
    } catch (err: any) {
      // Recording never masks the outcome of the call it is recording.
      console.error(`recording to ${this.path} failed: ${err?.message ?? err}`);
    }
  }
}

const split = (s: string) => s.split(/\s+/).filter(Boolean);

/** Read once, at selection time: a fixture that is missing or malformed must
 *  fail loudly here rather than as a mystery empty reply mid-run. */
export function loadFixture(path = process.env.EIL_LLM_FIXTURE): ReplayPack {
  if (!path) throw new Error("fixture provider: set EIL_LLM_FIXTURE to a JSON file of replies");
  try {
    return normalisePack(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err: any) {
    throw new Error(`fixture provider: cannot load ${path}: ${err?.message ?? String(err)}`);
  }
}

/**
 * Per-call name > EIL_LLM_PROVIDER env > a pack, when one is pointed at >
 * maas default.
 *
 * EIL_LLM_FIXTURE alone is enough to select replay, because "point it at a
 * recorded run" is one decision and should not need two environment variables
 * that can disagree. An explicit provider still wins, so a pack left in the
 * environment cannot silently override a caller that asked for a live model.
 */
export function getProvider(name?: string): Provider {
  const selected =
    name ?? process.env.EIL_LLM_PROVIDER ?? (process.env.EIL_LLM_FIXTURE ? "fixture" : "maas");
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

/** The suffix a replayed call's caller carries in `llm_calls`. */
export const REPLAY_SUFFIX = " (replay)";

/**
 * Local usage record — the only telemetry for CLI backends.
 *
 * A REPLAYED call is recorded, not skipped, and it is recorded honestly: the
 * `provider` column names whatever produced the text, and the fact that this
 * particular call replayed it lands on `caller`. That split is deliberate and
 * needs no migration:
 *
 *  - `provider` answers "who produced this judgment", which is the question the
 *    artefact's provenance has to agree with;
 *  - `caller` answers "what did this run actually spend", and a replay spent
 *    nothing. Cost and volume roll up by caller, so a rehearsal cannot quietly
 *    be summed into a month's model spend.
 */
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
      result.provenance === "replay" ? `${caller}${REPLAY_SUFFIX}` : caller,
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
