/**
 * The elaboration loop — the one thing in this phase that actually produces an
 * artefact.
 *
 * The rule it is built around: **the model emits only bounded judgments.** It
 * scores two bands, it names one question, it proposes child statements, it
 * writes acceptance criteria, and it rules on whether a document answers a
 * question. Everything else is computed here or in the modules this one calls:
 *
 *   magnitude, decision      scoring.ts        (recommendAction, magnitude)
 *   grounded vs escalated    ground.ts         (arithmetic, judgment, verification)
 *   acceptance-criterion ids assemble.ts       (nextAcId)
 *   every [G] field          assemble.ts       (assemble)
 *   the verdict              analyse.ts        (analyse)
 *
 * A model reply that volunteers a magnitude or a decision is not an error and is
 * not corrected — it is simply discarded, silently, because the loop never reads
 * those keys.
 *
 * Four properties this module exists to hold:
 *
 *  1. **The artefact is written even when the gate refuses it.** A refused
 *     artefact plus its findings is the honest output. There is no retry loop
 *     and no suppression path.
 *  2. **No sign-off is ever emitted.** There is no code here that can write one.
 *  3. **Every model call goes through `logCall(client, "reqs-elaborate", …)`,**
 *     with its outcome, so `llm_calls` records call volume and latency. CLI
 *     providers report no token counts and none are invented.
 *  4. **`metadata.corpusMode` is derived from the catalog that was read,** not
 *     from a flag, so a synthetic run cannot be presented as a live one.
 *
 * Rungs 1-3 of the cascade (CONTEXT.md, ARCHITECTURE.md, docs/) are deliberately
 * NOT wired up: `repoRoot` is never passed. A work item is elaborated against the
 * organisation's knowledge plane, and the repository this CLI happens to be run
 * from has nothing to say about it. Every resolution therefore comes back either
 * with a verified citation or with a named human.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Db } from "../db.js";
import {
  type LLMResult,
  type Provider,
  getProvider,
  logCall,
  parseJsonReply,
} from "../llm/index.js";
import type { Viewer } from "../search.js";
import { analyse } from "./analyse.js";
import { assemble, nextAcId } from "./assemble.js";
import { FIB, REGISTERED_CONSTANTS as K } from "./constants.js";
import type { DocFetcher, JudgeFn, Resolution, SearchFn } from "./ground.js";
import { resolveUnknown } from "./ground.js";
import { saveReqs } from "./io.js";
import {
  type NodeContext,
  acPrompt,
  childrenPrompt,
  judgePrompt,
  questionPrompt,
  scorePrompt,
} from "./prompt.js";
import type {
  AcceptanceCriterion,
  Clarification,
  ReqsBody,
  RequirementNodeT,
  ScorePass,
} from "./schema.js";
import { walk } from "./schema.js";
import { type Fib, magnitude, recommendAction } from "./scoring.js";

export type CorpusMode = "fixtures" | "live";

/** The caller name every row this module writes to `llm_calls` carries. */
export const CALLER = "reqs-elaborate";

/** Ceiling on tree size. Not a quality rule — a bound on how long one run may
 *  take and how much of a model's time it may spend. Hitting it is reported on
 *  stderr and leaves the offending branch un-decomposed, which the gate then
 *  refuses by name; it never silently finalises a node the loop did not finish. */
const DEFAULT_MAX_NODES = 40;

/** Reply budgets. Each prompt asks for a small object about a small subject. */
const TOKENS = { score: 256, children: 512, question: 256, criteria: 1024, judge: 512 };

export interface ElaborateDeps {
  /** the catalog: retrieval, citation verification, and the llm_calls ledger */
  client?: Db | undefined;
  viewer?: Viewer | undefined;
  /** injected (tests); otherwise selected by EIL_LLM_PROVIDER */
  provider?: Provider | undefined;
  providerName?: string | undefined;
  /** the work item's title and prose; read from the catalog when absent */
  title?: string | undefined;
  brief?: string | undefined;
  /** caller-declared facts about the delivery — never a model judgment */
  deliveryType?:
    | { kind: "ui" | "backend" | "migration" | "mixed"; tech: "new" | "legacy" }
    | undefined;
  /** derived from the catalog when absent; see `detectCorpusMode` */
  corpusMode?: CorpusMode | undefined;
  /** the human named on every escalated clarification */
  escalateTo?: string | undefined;
  /** written before this function returns, refused or not */
  out?: string | undefined;
  now?: (() => Date) | undefined;
  maxNodes?: number | undefined;
  /** passed straight through to the cascade; the defaults go via callTool */
  search?: SearchFn | undefined;
  fetchDoc?: DocFetcher | undefined;
  judge?: JudgeFn | undefined;
  /** the analyser's citation resolver (CLARIFY-005) */
  resolveDoc?: ((docId: string) => Promise<string | null>) | undefined;
}

/** A criterion as the model states it: no id, because ids are allocated here. */
interface RawCriterion {
  stakeholder: string;
  given: string;
  when: string;
  then: string[];
}

/**
 * How the catalog was populated, read off the catalog rather than taken on
 * trust from a flag.
 *
 * The synthetic corpus is published under `example.com` — a domain reserved by
 * RFC 2606 that no corporate Confluence or Jira can serve — so a document whose
 * url is not on it cannot have come from the fixtures, and a fixture-ingested
 * document always is. The catalog is `fixtures` only when EVERY document in it
 * is synthetic; one real page makes the whole run `live`.
 *
 * An empty catalog reports `fixtures`. That is the under-claiming direction on
 * purpose: the failure that matters is a synthetic run narrated to executives as
 * a live one, never the reverse.
 */
export async function detectCorpusMode(client: Db): Promise<CorpusMode> {
  const { rows } = await client.query(
    "SELECT count(*)::int AS total," +
      " sum(CASE WHEN url LIKE '%example.com/%' THEN 1 ELSE 0 END)::int AS synthetic" +
      " FROM documents",
  );
  const total = Number(rows[0]?.total ?? 0);
  const synthetic = Number(rows[0]?.synthetic ?? 0);
  if (total === 0) return "fixtures";
  return synthetic === total ? "fixtures" : "live";
}

/** Nearest band. Used only after the model has been asked twice and has twice
 *  answered off-band; the coercion is written into the pass note, so the
 *  artefact records that it happened rather than hiding it. */
function snapFib(n: number): Fib {
  let best: Fib = FIB[0];
  for (const b of FIB) if (Math.abs(b - n) < Math.abs(best - n)) best = b;
  return best;
}

const isFibNumber = (n: unknown): n is Fib =>
  typeof n === "number" && (FIB as readonly number[]).includes(n);

/** `a-z0-9`, `-` and `.` only, no leading, trailing or doubled separator. */
function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s === "" ? "node" : s;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The whole loop, as one object so the counters and the collected
 *  clarifications cannot drift out of step with the tree being built. */
class Elaboration {
  private readonly provider: Provider;
  private readonly clarifications: Clarification[] = [];
  private readonly pending = new Map<string, RawCriterion[]>();
  private readonly keys = new Set<string>();
  private readonly maxNodes: number;
  private nodes = 0;
  private clCount = 0;
  private model: string | null = null;

  constructor(
    private readonly workItem: string,
    private readonly title: string,
    private readonly brief: string,
    private readonly escalateTo: string,
    private readonly deps: ElaborateDeps,
  ) {
    this.provider = deps.provider ?? getProvider(deps.providerName);
    this.maxNodes = deps.maxNodes ?? DEFAULT_MAX_NODES;
  }

  get providerName(): string {
    return this.provider.name;
  }

  get generatorModel(): string | null {
    return this.model;
  }

  get ledger(): Clarification[] {
    return this.clarifications;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private at(): string {
    return this.now().toISOString();
  }

  /**
   * One model call, recorded. `ok` is false when the call threw AND when it
   * returned something that is not the object it was asked for — from the
   * ledger's point of view a reply nobody could use is a call that did not
   * work. No token counts are synthesised: CLI providers report none, and a
   * fabricated count is worse than a null.
   */
  private async call(prompt: string, maxTokens: number): Promise<Record<string, unknown>> {
    let last = "";
    // Two attempts, and only for a malformed envelope: a reply that is not JSON
    // is a protocol failure, not a judgment the pipeline has to respect. There
    // is no retry anywhere for a judgment the loop dislikes.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = performance.now();
      let result: LLMResult;
      try {
        result = await this.provider.complete(prompt, { maxTokens });
      } catch (err: any) {
        await this.record(
          {
            text: "",
            provider: this.provider.name,
            model: null,
            latencyMs: Math.round(performance.now() - started),
          },
          false,
        );
        throw new Error(`${CALLER}: model call failed: ${String(err?.message ?? err)}`);
      }
      if (result.model) this.model = result.model;
      try {
        const reply = parseJsonReply(result.text);
        await this.record(result, true);
        return reply;
      } catch (err: any) {
        last = String(err?.message ?? err);
        await this.record(result, false);
      }
    }
    throw new Error(
      `${CALLER}: the model did not return a JSON object after two attempts: ${last}`,
    );
  }

  private async record(result: LLMResult, ok: boolean): Promise<void> {
    if (!this.deps.client) return;
    try {
      await logCall(this.deps.client, CALLER, result, ok);
    } catch (err: any) {
      // Bookkeeping never masks the outcome of the call it is recording.
      console.error(`llm_calls insert skipped: ${err?.message ?? err}`);
    }
  }

  private context(statement: string, ancestors: string[]): NodeContext {
    return { workItem: this.workItem, title: this.title, brief: this.brief, ancestors, statement };
  }

  /** The two bands, and nothing else. A magnitude or a decision in the reply is
   *  never read, so it cannot reach the artefact. */
  private async score(
    ctx: NodeContext,
    resolved?: string,
  ): Promise<{ u: Fib; c: Fib; note: string }> {
    const prompt = resolved === undefined ? scorePrompt(ctx) : scorePrompt(ctx, resolved);
    let reply = await this.call(prompt, TOKENS.score);
    if (!isFibNumber(reply.unknowns) || !isFibNumber(reply.complexity)) {
      reply = await this.call(prompt, TOKENS.score);
    }
    const rawU = Number(reply.unknowns);
    const rawC = Number(reply.complexity);
    const u = isFibNumber(rawU) ? rawU : snapFib(Number.isFinite(rawU) ? rawU : 8);
    const c = isFibNumber(rawC) ? rawC : snapFib(Number.isFinite(rawC) ? rawC : 8);
    const off: string[] = [];
    if (u !== rawU) off.push(`unknowns snapped to ${u} from ${JSON.stringify(reply.unknowns)}`);
    if (c !== rawC) off.push(`complexity snapped to ${c} from ${JSON.stringify(reply.complexity)}`);
    const rationale = str(reply.rationale) || "no rationale given";
    return { u, c, note: off.length === 0 ? rationale : `${rationale} [${off.join("; ")}]` };
  }

  private pass(u: Fib, c: Fib, decision: ScorePass["decision"], note: string): ScorePass {
    return {
      unknowns: u,
      complexity: c,
      magnitude: magnitude(u, c),
      decision,
      at: this.at(),
      note,
    };
  }

  private async children(ctx: NodeContext): Promise<string[]> {
    const read = (reply: Record<string, unknown>): string[] =>
      (Array.isArray(reply.children) ? reply.children : []).map(str).filter(Boolean).slice(0, 5);
    let out = read(await this.call(childrenPrompt(ctx), TOKENS.children));
    if (out.length < 2) out = read(await this.call(childrenPrompt(ctx), TOKENS.children));
    return out;
  }

  private async question(ctx: NodeContext): Promise<string> {
    const reply = await this.call(questionPrompt(ctx), TOKENS.question);
    const q = str(reply.question);
    return q === "" ? `What is not yet decided about: ${ctx.statement}` : q;
  }

  private async criteria(ctx: NodeContext): Promise<RawCriterion[]> {
    const read = (reply: Record<string, unknown>): RawCriterion[] =>
      (Array.isArray(reply.criteria) ? reply.criteria : [])
        .map((raw: any) => ({
          stakeholder: str(raw?.stakeholder),
          given: str(raw?.given),
          when: str(raw?.when),
          // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
          then: (Array.isArray(raw?.then) ? raw.then : [raw?.then]).map(str).filter(Boolean),
        }))
        .filter((c: RawCriterion) => c.given !== "" || c.when !== "" || c.then.length > 0)
        .slice(0, 4);
    let out = read(await this.call(acPrompt(ctx), TOKENS.criteria));
    if (out.length === 0) out = read(await this.call(acPrompt(ctx), TOKENS.criteria));
    return out;
  }

  /** The judgment step of the cascade, injected so that it is logged under this
   *  run's caller with its outcome, exactly like every other model call. */
  private judge(): JudgeFn {
    if (this.deps.judge) return this.deps.judge;
    return async (question, docs) => {
      const reply = await this.call(judgePrompt(question, docs), TOKENS.judge);
      return {
        answers: reply.answers === true,
        quote: str(reply.quote),
        rationale: str(reply.rationale),
      };
    };
  }

  /**
   * Grounded or escalated — and the difference is decided by `ground.ts`, never
   * here. A resolution with a verified citation becomes an answered
   * clarification; anything else becomes an OPEN one that names the human who
   * has to answer it, which is what CLARIFY-002 then refuses the artefact for.
   */
  private clarify(nodeId: string, question: string, res: Resolution): Clarification {
    this.clCount += 1;
    const id = `CL-${this.clCount}`;
    const cited = res.grounding[0];
    if (res.answer === null || cited === undefined) {
      return {
        id,
        nodeId,
        question,
        options: [],
        answeredBy: { kind: "human", name: this.escalateTo },
        grounding: [],
      };
    }
    return {
      id,
      nodeId,
      question,
      options: [],
      answer: { freetext: res.answer },
      answeredBy: { kind: "knowledge_base", name: cited.docId },
      answeredAt: this.at(),
      resultingDetail: `Answered from ${cited.docId} — ${cited.title}. The quote below was re-read from that document and matched character for character.`,
      resolvedFrom: res.rung,
      grounding: res.grounding,
    };
  }

  private nodeKey(statement: string, id: string): string {
    const base = slug(statement);
    if (!this.keys.has(base)) {
      this.keys.add(base);
      return base;
    }
    // The id is unique by construction, so this always terminates.
    const key = `${base}.${slug(id)}`;
    this.keys.add(key);
    return key;
  }

  async node(
    statement: string,
    id: string,
    parentId: string | undefined,
    ancestors: string[],
    depth: number,
    priorU?: Fib,
  ): Promise<RequirementNodeT> {
    this.nodes += 1;
    const ctx = this.context(statement, ancestors);
    const first = await this.score(ctx);
    let decision = recommendAction(first.u, first.c, priorU);
    const history: ScorePass[] = [this.pass(first.u, first.c, decision, first.note)];
    let resolvedFrom: RequirementNodeT["resolvedFrom"];

    if (decision === "clarify") {
      const question = await this.question(ctx);
      const res = await resolveUnknown(question, {
        ...(this.deps.client ? { client: this.deps.client } : {}),
        ...(this.deps.viewer ? { viewer: this.deps.viewer } : {}),
        ...(this.deps.search ? { search: this.deps.search } : {}),
        ...(this.deps.fetchDoc ? { fetchDoc: this.deps.fetchDoc } : {}),
        judge: this.judge(),
      });
      this.clarifications.push(this.clarify(id, question, res));
      if (res.answer !== null && res.grounding.length > 0) {
        resolvedFrom = res.rung;
        // Re-score in the light of what the corpus actually said. The decision
        // is recomputed from the new bands against the OLD ones, so a
        // clarification that did not reduce the unknown cannot quietly become a
        // decomposition — `recommendAction` returns "clarify" again, and the
        // node stops there rather than asking the same question twice.
        const again = await this.score(ctx, res.answer);
        decision = recommendAction(again.u, again.c, first.u);
        history.push(this.pass(again.u, again.c, decision, again.note));
      }
    }

    let children: RequirementNodeT[] | undefined;
    if (decision === "decompose") {
      if (depth >= K.maxDepth) {
        console.error(
          `${id} is a decompose at maxDepth ${K.maxDepth} and was left un-decomposed — the gate will refuse it`,
        );
      } else if (this.nodes >= this.maxNodes) {
        console.error(
          `${id} was left un-decomposed: the run reached its ${this.maxNodes}-node ceiling — the gate will refuse it`,
        );
      } else {
        const statements = await this.children(ctx);
        children = [];
        for (let i = 0; i < statements.length; i += 1) {
          children.push(
            await this.node(
              statements[i]!,
              `${id}.${i + 1}`,
              id,
              [...ancestors, statement],
              depth + 1,
              first.u,
            ),
          );
        }
      }
    } else if (decision === "leaf") {
      this.pending.set(id, await this.criteria(ctx));
    }

    const current = history[history.length - 1]!;
    const node: RequirementNodeT = {
      id,
      ...(parentId === undefined ? {} : { parentId }),
      nodeKey: this.nodeKey(statement, id),
      statement,
      score: current,
      scoreHistory: history,
      decision,
      isLeaf: decision === "leaf",
      grounding: [],
      ...(resolvedFrom === undefined ? {} : { resolvedFrom }),
    };
    if (children !== undefined) node.children = children;
    return node;
  }

  /** Ids are allocated by `nextAcId` over the body being built, one at a time,
   *  so the allocator sees every id it has already issued. */
  allocateAcIds(body: ReqsBody): void {
    for (const { node } of walk(body.tree)) {
      const raw = this.pending.get(node.id);
      if (raw === undefined) continue;
      const acs: AcceptanceCriterion[] = [];
      node.acceptanceCriteria = acs;
      for (const c of raw) {
        acs.push({
          id: nextAcId(body),
          stakeholder: c.stakeholder,
          given: c.given,
          when: c.when,
          // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
          then: c.then,
          observable: false, // [G] — assemble() owns this
        });
      }
    }
  }
}

/** The pipeline's own version, for `metadata.generator`. */
async function version(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf-8");
    const v = JSON.parse(raw).version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

/** The work item itself, read through the audited tool path under the caller's
 *  viewer — so a work item this caller may not see is not elaborated. */
async function readWorkItem(
  client: Db,
  viewer: Viewer,
  docId: string,
): Promise<{ title: string; body: string; author: string | null } | null> {
  const { callTool } = await import("../tools.js");
  const doc = await callTool("get_doc", { id: docId }, viewer, client);
  if (typeof doc.error === "string" || typeof doc.body !== "string") return null;
  // The ACL decision has already been made, on this exact id, by the read above.
  // This second query only fetches the field `get_doc` does not project.
  let author: string | null = null;
  try {
    const { rows } = await client.query("SELECT author FROM documents WHERE id = $1", [docId]);
    author = typeof rows[0]?.author === "string" ? rows[0].author : null;
  } catch {
    author = null;
  }
  return { title: typeof doc.title === "string" ? doc.title : docId, body: doc.body, author };
}

/**
 * Elaborate one work item into a gated requirements artefact.
 *
 * Returns the body, refused or not, and writes it to `deps.out` first when one
 * is given — the write is not conditional on the verdict anywhere in this
 * function, and that is the point.
 */
export async function elaborate(workItem: string, deps: ElaborateDeps): Promise<ReqsBody> {
  const docId = workItem.includes(":") ? workItem : `jira:issue:${workItem}`;
  let title = deps.title;
  let brief = deps.brief;
  let owner = deps.escalateTo;

  if (deps.client && deps.viewer && (title === undefined || brief === undefined)) {
    const doc = await readWorkItem(deps.client, deps.viewer, docId);
    if (doc === null) {
      throw new Error(
        `${CALLER}: ${docId} is not in the catalog, or this viewer may not read it — ingest it first`,
      );
    }
    title ??= doc.title;
    brief ??= doc.body;
    owner ??= doc.author ?? undefined;
  }
  if (title === undefined || brief === undefined) {
    throw new Error(`${CALLER}: no catalog and no title/brief supplied for ${workItem}`);
  }

  const corpusMode =
    deps.corpusMode ?? (deps.client ? await detectCorpusMode(deps.client) : "fixtures");
  const escalateTo = owner ?? `(no owner recorded in the catalog for ${workItem})`;

  const loop = new Elaboration(workItem, title, brief, escalateTo, deps);
  const createdAt = (deps.now ? deps.now() : new Date()).toISOString();
  const tree = await loop.node(title, "REQ-ROOT", undefined, [], 1);

  let body: ReqsBody = {
    schemaVersion: "1.0",
    metadata: {
      workItem,
      title,
      deliveryType: deps.deliveryType ?? { kind: "backend", tech: "legacy" },
      createdAt,
      updatedAt: (deps.now ? deps.now() : new Date()).toISOString(),
      executionProfile: { mode: "full" },
      generator: {
        agent: `eil reqs elaborate via ${loop.providerName}`,
        model: loop.generatorModel,
        version: await version(),
      },
      corpusMode,
    },
    tree,
    clarifications: loop.ledger,
    residuals: [],
    traceability: {},
  };

  loop.allocateAcIds(body);
  // Generated fields are written once, by their only writer.
  body = assemble(body);

  // The gate runs, and its verdict is recorded in the artefact whatever it says.
  const result = await analyse(body, {
    ...(deps.resolveDoc ? { resolveDoc: deps.resolveDoc } : {}),
  });
  body.analysis = {
    ranAt: (deps.now ? deps.now() : new Date()).toISOString(),
    checksRun: result.checksRun,
    findings: result.findings,
  };

  if (deps.out !== undefined) {
    await mkdir(dirname(deps.out), { recursive: true });
    await saveReqs(deps.out, body);
  }
  return body;
}
