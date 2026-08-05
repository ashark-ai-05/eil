/**
 * Query execution: router -> executors -> fusion. The deterministic query path.
 * Every read is ACL-filtered server-side (fail-closed, on both the focal and
 * destination documents) — the predicate is never caller-controlled.
 */

import { userInfo } from "node:os";
import { z } from "zod";
import { rrf } from "./core/fusion.js";
import { modifier } from "./core/ranking.js";
import { type Route, classify } from "./core/router.js";
import type { Db } from "./db.js";
import { type Embedder, getEmbedder, toVec } from "./embed/index.js";
import { OVERSAMPLE, loadCentroids, probeClusters, signature } from "./embed/ivf.js";
import { ATTR, OP, currentTrace, withSpan } from "./telemetry.js";

/**
 * Fragment sizing shared by BOTH the marked (display) snippet and the
 * marker-free coverage measurement below — one structured source so the two
 * ts_headline() option strings cannot drift apart. An earlier version built
 * SNIPPET_COVERAGE_OPTS by `String.replace()`-ing the literal marker spelling
 * out of SNIPPET_OPTS: a later edit to that spelling would have made the
 * replace silently no-op, coverage would then be measured WITH markers still
 * in it, and the inflated length pushes `truncated` toward the dangerous
 * false-when-incomplete direction (measured: markers left in gave coverage
 * 87 vs text_len 73 on a case that should have measured 73 vs 73). Deriving
 * both option strings from this one constant makes that drift structurally
 * impossible rather than something a comment has to keep warning about.
 *
 * MaxWords is a PER-FRAGMENT cap, not a total for the whole snippet — measured
 * directly against Postgres/PGlite: at MaxWords=90 a two-fragment headline came
 * back 177-178 words / ~1.2-1.3K characters, roughly double what "MaxWords=90"
 * reads as. MaxWords=45 is what actually lands near the intended ~90 words
 * across MaxFragments=2 (measured worst case 88 words / 639 chars), which is
 * the ~6-sentence point where Provence (ICLR 2025) measured query-biased
 * extraction holding answer quality while removing 50-80% of the context, and
 * close to the ~60-token extract that scored best in "Searching for Best
 * Practices in RAG". Two fragments rather than one because a question's
 * evidence is frequently split across a document.
 */
const SNIPPET_FRAGMENT_OPTS = "MaxWords=45, MinWords=30, MaxFragments=2, FragmentDelimiter= … ";

/** Quoted markers, always — measured directly: an UNQUOTED empty value
 *  (`StartSel=, StopSel=,`) is not "empty selector", it is a ts_headline
 *  options-parser bug where the bare comma gets swallowed into the value and
 *  re-emitted literally in the output ("The retry policy" came back ",retry,
 *  policy", commas and all). A quoted non-empty marker (`StartSel="**"`)
 *  measured byte-identical output to the old unquoted form, so quoting
 *  unconditionally costs nothing and removes the empty-value special case. */
const tsHeadlineOpts = (marker: string): string =>
  `StartSel="${marker}", StopSel="${marker}", ${SNIPPET_FRAGMENT_OPTS}`;

/** Sized for an agent deciding whether to call get_doc — NOT for a human
 *  scanning a page. The old MaxWords=40 was ~200 characters, which is below
 *  the point where an extract can answer anything, so the agent fetched the
 *  whole document and paid for it. See SNIPPET_FRAGMENT_OPTS for the sizing
 *  rationale and measurements. */
export const SNIPPET_OPTS = tsHeadlineOpts("**");
/**
 * Same fragment sizing as SNIPPET_OPTS, empty markers, so ts_headline
 * extracts the exact same fragments with nothing to strip. Used only to
 * MEASURE coverage, never for display: stripping literal "**" from the
 * marked snippet in JS also strips "**" that occurs in the SOURCE TEXT
 * (Confluence prefixes labelled pages with "**Labels:** ...",
 * ts/ingest/confluence.ts:36; Obsidian bodies are markdown throughout),
 * which corrupted the truncated flag in 13.4% of a 1500-case fuzz run
 * (measured) — e.g. "The **retry** policy uses **backoff** throughout."
 * stripped to fewer characters than the 48-char source even though the
 * snippet covered all of it. A second, marker-free ts_headline() call has
 * nothing to strip, so its length is exact rather than heuristic.
 */
export const SNIPPET_COVERAGE_OPTS = tsHeadlineOpts("");
/** Measured worst case for SNIPPET_OPTS (MaxWords=45/MinWords=30/MaxFragments=2)
 *  on the lexical arm: 639 chars / 88 words when matches cluster in one place.
 *  540 keeps this arm's plain leading extract (no ts_headline, no query bias)
 *  in the same ballpark rather than the ~2.2x mismatch MaxWords=90 produced —
 *  "same ballpark", not byte-identical, since the two arms extract differently. */
export const VEC_SNIPPET_CHARS = 540;
export const GET_DOC_MAX_CHARS = 8_000;
export const EXPAND_MAX_EDGES = 50;

// Mandatory, fail-closed visibility: a request always has exactly one tenant.
// Only static $-indices ever reach SQL text.
//
// Superseded documents are excluded HERE, beside the ACL and tombstone tests,
// rather than being down-weighted in ranking. Two reasons. A rank penalty is a
// suggestion — a superseded page that is a much better lexical match still
// surfaces, and "the retry limit is 3" from a replaced policy is not a slightly
// worse answer, it is a wrong one. And putting it in the single predicate every
// arm already composes means a future arm cannot forget it, which is the same
// property that keeps the ACL honest.
//
// `valid_to IS NULL` (not `> now()`) is deliberate: validity is stamped at
// ingest from what the source said, so retrieval stays a pure function of the
// catalog and two identical queries cannot disagree because a clock ticked.
const visibleSql = (
  principalIdx: number,
  groupsIdx: number,
  tenantIdx: number,
  includeSuperseded = false,
) =>
  `((d.ingested_by = $${principalIdx} OR d.acl_groups ?| $${groupsIdx}::text[])` +
  ` AND d.tenant = $${tenantIdx} AND d.tombstoned_at IS NULL AND d.quarantined_at IS NULL` +
  // ONLY the validity clause is optional. ACL, tenant, tombstone and quarantine
  // stay unconditional: asking for history must never be a way to ask for
  // someone else's documents.
  `${includeSuperseded ? "" : " AND d.valid_to IS NULL"})`;

export interface Viewer {
  principal: string;
  groups: string[];
  tenant: string;
}

/** Validated claims required at any shared/API boundary. Never accept a caller-
 * constructed Viewer in such a boundary: tenant and group membership must come
 * from a verified token/session before this function is called. */
const AuthenticatedClaims = z.object({
  principal: z.string().min(1),
  tenant: z.string().min(1),
  groups: z.array(z.string().min(1)).default([]),
});
export type AuthenticatedClaims = z.infer<typeof AuthenticatedClaims>;

// A runtime capability prevents a shared host from passing a structurally
// equivalent, caller-controlled object to callTool(). The host must verify its
// token/session first, then construct this capability from the resulting claims.
const trustedViewers = new WeakSet<Viewer>();
function trustedViewer(claims: AuthenticatedClaims): Viewer {
  const viewer: Viewer = {
    principal: claims.principal,
    tenant: claims.tenant,
    groups: claims.groups,
  };
  trustedViewers.add(viewer);
  return viewer;
}
export const viewerFromAuthenticatedClaims = (claims: unknown): Viewer =>
  trustedViewer(AuthenticatedClaims.parse(claims));
export const isTrustedViewer = (viewer: Viewer): boolean => trustedViewers.has(viewer);

/** Local stdio/CLI mode only. Shared HTTP mode must call
 * viewerFromAuthenticatedClaims() after token verification. */

/**
 * Arm weights come from the query router rather than a tuned constant: it
 * already distinguishes a natural-language question from an identifier, path or
 * quoted string, and it is unit-tested. A prose question leans on the prose arm;
 * `retryHandler` or `src/retry.ts` leans on the code arm. Neither is silenced —
 * the loser is down-weighted, not dropped.
 */
const CODE_LEANING_ROUTES: ReadonlySet<Route> = new Set<Route>(["symbol", "path", "exact"]);
const OFF_LEAN_WEIGHT = 0.6;

function armWeights(route: Route): Record<string, number> {
  const leansCode = CODE_LEANING_ROUTES.has(route);
  const prose = leansCode ? OFF_LEAN_WEIGHT : 1.0;
  const code = leansCode ? 1.0 : OFF_LEAN_WEIGHT;
  // strict and loose share a class weight; precision comes from strict matches
  // appearing in both lists rather than from weighting them differently.
  return {
    fts_prose: prose,
    fts_prose_loose: prose,
    fts_code: code,
    fts_code_loose: code,
    vec: 1.0,
  };
}

/**
 * The identity a local CLI or stdio MCP process reads with.
 *
 * `EIL_PRINCIPAL` overrides the OS username, alongside the `EIL_USER_GROUPS`
 * override that was already here. It exists so you can ask what a DIFFERENT
 * person would get back from the same query — which is the only way to show a
 * fail-closed ACL doing its job, since the person running the command is
 * usually the one who ingested the corpus and therefore owns all of it.
 *
 * This confers nothing that setting EIL_USER_GROUPS did not already confer. In
 * local mode the caller owns the process and the DSN, so identity here is an
 * assertion, not a claim to be checked. The trust boundary is elsewhere and
 * unmoved: a shared HTTP deployment must build its viewer with
 * viewerFromAuthenticatedClaims() after verifying a token, and must never
 * reach this function.
 */
export function localViewer(): Viewer {
  const raw = process.env.EIL_USER_GROUPS ?? "";
  return trustedViewer({
    principal: process.env.EIL_PRINCIPAL || userInfo().username,
    tenant: process.env.EIL_TENANT ?? "default",
    groups: raw
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
  });
}

export interface SearchResult {
  id: string;
  title: string;
  url: string | null;
  tier: string;
  snippet: string;
  /** False means the snippet already contains the entire DOCUMENT that
   *  get_doc would return — there is nothing more to fetch. Scoped to the
   *  document rather than the one matched chunk: a chunk can be short enough
   *  to fit the snippet budget while the document around it is not (see the
   *  doc_len comment in searchDocsInner's lexical query). An agent that
   *  cannot tell these apart fetches defensively, every time.
   *
   *  Because the chunker strips heading lines from chunk text, coverage_len
   *  can never reach text_len on any document with markdown headings, which
   *  makes truncated collapse to `true` on most real corpora — an honest
   *  worst-case signal, not a bug, but not an actionable one on its own.
   *  section_index/section_count below are the actionable half: they tell
   *  the agent WHICH PART of the document it is looking at, so it can decide
   *  "I found my answer in section 2 of 5, no need to fetch the rest" even
   *  though truncated is (correctly) true. */
  truncated: boolean;
  /** Zero-based index of the chunk the snippet came from, among this
   *  document's chunks. NOT get_doc's `section` — that is a BYTE-PAGINATION
   *  page (GET_DOC_MAX_CHARS windows), a different unit entirely; see the
   *  comment at getDoc's `section` field. */
  section_index: number;
  /** How many chunks this document has in total (tenant-scoped count against
   *  `chunks`). NOT get_doc's `total_sections` — that counts byte-pagination
   *  pages, not chunks; see the comment at getDoc's `total_sections` field. */
  section_count: number;
  score?: number;
}

export interface Edge {
  id: string;
  rel: string;
  direction: "in" | "out";
  title: string | null;
  ingested: boolean;
}

/**
 * Restrict a search to a subset of sources.
 *
 * `null`/absent means every source, which is the only behaviour there was
 * before this existed. An EMPTY array is not the same thing as absent: it
 * names no sources and therefore matches nothing. Treating `[]` as "no filter"
 * would turn a caller's mistake into a silent widening of scope, which is the
 * wrong direction for a predicate that sits next to the ACL.
 */
export interface SearchOptions {
  sources?: readonly string[] | null;
  /**
   * Include documents the source has retired. Default false.
   *
   * "Excluded by default" must not mean "unreachable": an operator asking what
   * the policy USED to be is a legitimate question, and a direct id turning into
   * a permanent undocumented 404 would be its own bug. This relaxes only the
   * validity clause — ACL, tenant, tombstone and quarantine stay unconditional.
   */
  includeSuperseded?: boolean;
}

/** Normalised to `null` (no filter) or a non-empty array, once, at the entry point. */
const sourceFilter = (opts?: SearchOptions): string[] | null =>
  opts?.sources == null ? null : [...opts.sources];

export async function searchDocs(
  client: Db,
  viewer: Viewer,
  query: string,
  limit = 8,
  embedder?: Embedder,
  opts?: SearchOptions,
): Promise<Record<string, unknown>> {
  return withSpan(
    `${OP.retrieval} eil`,
    { [ATTR.operation]: OP.retrieval, [ATTR.dataSource]: "eil" },
    async (span) => {
      const out = await searchDocsInner(client, viewer, query, limit, embedder, opts);
      // The arms that actually ran — route != executor is the interesting case,
      // and a silently-missing vector arm shows up here rather than nowhere.
      if (typeof out.route === "string") span.setAttribute("eil.route", out.route);
      if (typeof out.executor === "string") span.setAttribute("eil.executor", out.executor);
      if (Array.isArray(out.results)) span.setAttribute("eil.results", out.results.length);
      return out;
    },
  );
}

async function searchDocsInner(
  client: Db,
  viewer: Viewer,
  query: string,
  limit: number,
  embedder?: Embedder,
  opts?: SearchOptions,
): Promise<Record<string, unknown>> {
  const decision = classify(query);
  const sources = sourceFilter(opts);
  const includeSuperseded = opts?.includeSuperseded === true;
  // Both shortcuts below bypass the arms entirely and answer out of one source,
  // so each has to ask permission first. A scope the router can route around is
  // not a scope: "CHK-9" would return a Jira issue from a search restricted to
  // the wiki, and the caller would never see which path produced it.
  const inScope = (source: string) => sources === null || sources.includes(source);

  if (decision.route === "entity" && inScope("jira")) {
    const entityId = `jira:issue:${decision.match}`;
    const doc = await getDoc(client, viewer, entityId, 0, 2_000, includeSuperseded);
    const neighborhood = await expand(client, viewer, entityId);
    // Every response carries freshness, including the shortcuts. A contract the
    // fast paths quietly opt out of is not a contract.
    return {
      route: "entity",
      entity: doc,
      linked: neighborhood.edges,
      ...evidenceBounds([toDate(doc?.updated_at)]),
      corpus_current_to: await corpusCurrentTo(client, viewer.tenant),
    };
  }
  if (
    inScope("code") &&
    (decision.route === "path" || decision.route === "symbol" || decision.route === "exact")
  ) {
    const { searchCodeIndex } = await import("./code-search.js");
    const kind = decision.route === "exact" ? "literal" : decision.route;
    const code = await searchCodeIndex(client, viewer, {
      query: decision.match ?? query,
      kind,
      limit,
      includeSuperseded,
    });
    if (code.results.length > 0)
      return {
        route: decision.route,
        ...code,
        // Typed field, not an unchecked cast: the previous `(r as {updated_at})`
        // read a property CodeCitation never had, so every code-route bound was
        // silently null even for dated files — a claim of "unknown freshness"
        // that was really "I forgot to select the column".
        ...evidenceBounds(code.results.map((r) => toDate(r.updatedAt))),
        corpus_current_to: await corpusCurrentTo(client, viewer.tenant),
      };
  }

  // Lexical candidates, with two properties the naive query lacked:
  //   best AS  — one row per DOC before any cut. The pool used to be capped in
  //              CHUNKS, so a handful of large code files could consume it and
  //              prose never entered the running at all.
  //   quota AS — a separate allowance per source class, so code competes with
  //              code. ts_rank is also normalized by length (flag 1); on its own
  //              that is not enough, because ts_rank has no IDF and no tf
  //              saturation, but it is a real improvement WITHIN an arm.
  const res = await client.query(
    `WITH q AS (
       SELECT websearch_to_tsquery('english', $1) AS strict
     ), qq AS (
       -- websearch_to_tsquery ANDs every content word, so recall collapses as a
       -- question gets longer: "how does the payment retry backoff policy work"
       -- became 'payment'&'retri'&'backoff'&'polici'&'work' and matched NOTHING
       -- in a corpus containing a page titled "Payment Retry Policy".
       -- The loose form ORs the same terms. Phrases survive because <-> binds
       -- tighter than |, but NEGATION must never be relaxed: 'retri' | !'jira'
       -- would match every document that simply lacks the word jira.
       SELECT strict,
              CASE WHEN strict::text LIKE '%!%' THEN strict
                   ELSE replace(strict::text, '&', '|')::tsquery END AS loose
         FROM q
     ), m AS (
       SELECT c.doc_id, c.seq, c.text, d.source, d.title, d.url, d.quality_tier, d.updated_at,
              ts_rank(c.tsv, qq.loose, 1) AS rank,
              (c.tsv @@ qq.strict) AS strict_hit
         FROM chunks c JOIN documents d ON d.tenant = c.tenant AND d.id = c.doc_id CROSS JOIN qq
        WHERE c.tsv @@ qq.loose AND ${visibleSql(4, 5, 6, includeSuperseded)}
          AND ($7::text[] IS NULL OR d.source = ANY($7::text[]))
     ), best AS (
       SELECT DISTINCT ON (doc_id) * FROM m ORDER BY doc_id, strict_hit DESC, rank DESC, seq
     ), quota AS (
       SELECT *, ROW_NUMBER() OVER (
                   PARTITION BY (source = 'code'), strict_hit ORDER BY rank DESC, doc_id) AS rn
         FROM best
     ), picked AS (
       -- Cut to the ~limit*3 candidates BEFORE anything below touches a
       -- document body. doc_len used to be computed inside m, over every
       -- MATCHING CHUNK ROW for every candidate document, before this cut and
       -- before DISTINCT ON collapsed to one row per doc — regexp_replace
       -- over the full body that many times measured 1640ms on a 200-doc,
       -- 4800-chunk, 51KB-body corpus. Computed here instead (~24 rows for
       -- the default limit=8), the same corpus measured 23ms — ~70x. See the
       -- report for the full before/after table.
       SELECT * FROM quota WHERE rn <= $3
     )
     -- Re-joining documents here, on ids picked already carries, is safe:
     -- every doc_id in picked already passed visibleSql() inside m above
     -- (picked <- quota <- best <- m), so this reads no document row that
     -- wasn't already ACL-cleared — the same pattern the vector arm's final
     -- SELECT already uses for its own doc_len, and the reviewer confirmed
     -- both placements produce identical text_len values (23ms either way,
     -- once it runs on the cut set rather than the uncut one).
     SELECT picked.doc_id, picked.source, picked.strict_hit, picked.title, picked.url,
            picked.quality_tier, picked.updated_at, picked.seq,
            -- Chunk count for this document, tenant-scoped, computed here on
            -- the ~limit*3 already-cut candidates — NOT inside m, which was
            -- exactly the mistake doc_len made (measured 1640ms -> 23ms by
            -- moving off the pre-cut path; see the picked CTE comment above).
            -- chunks' primary key is (tenant, doc_id, seq), so this is an
            -- index range scan per row, not a table scan.
            (SELECT count(*) FROM chunks ch2
              WHERE ch2.tenant = $6 AND ch2.doc_id = picked.doc_id) AS section_count,
            -- 'truncated' has to describe what get_doc would return — the
            -- whole DOCUMENT — not the one matched CHUNK. Comparing against
            -- the chunk's own length reported truncated:false on every result
            -- from a well-chunked page: tests/golden/confluence_page.chunks.json
            -- (one real Confluence page) is 5 chunks of 103-213 chars, every
            -- one comfortably inside the snippet budget, so a chunk-scoped
            -- comparison called ALL FIVE fully covered while get_doc actually
            -- holds 4 more sections the agent never saw.
            -- ts_headline drops the run of non-word characters attached to
            -- the outermost matched word at EITHER end once MaxFragments >= 1
            -- — measured directly, trailing: 'Retry uses backoff.' (19 chars)
            -- headlined with this file's MaxFragments=2 options comes back
            -- '**Retry** uses **backoff**', no trailing period. Leading:
            -- ts/ingest/confluence.ts:36 prefixes every labelled page with a
            -- '**Labels:** a, b' line, a blank line, then the body. A body
            -- starting '**Labels:** payments, ops' (blank line) 'Retry uses
            -- backoff...' headlines to 'Labels:** payments, ops' (blank
            -- line) '**Retry** uses **backoff**...' — the leading '**' gone,
            -- everything else intact. Both are the wrong direction (see the
            -- comment on covered, below in JS) if left uncompensated: a
            -- plain length(body) would flag a fully covered single-chunk
            -- document truncated. Strip the same leading AND trailing runs
            -- here so text_len matches what ts_headline can actually return.
            --
            -- This does NOT close every gap ts_headline can open: a leading
            -- STOPWORD immediately before the first matched term ('The
            -- retry...' -> '**retry**...', dropping the real word 'The', not
            -- just punctuation) is a separate, deeper behaviour no regex on
            -- the raw body can predict without literally re-running
            -- ts_headline on the whole document. Left uncompensated, it can
            -- only push truncated toward true on a document that is in fact
            -- fully covered — safe-direction (an occasional redundant
            -- get_doc), never the dangerous direction (see covered, below).
            length(regexp_replace(d.body, '^\\W+|\\W+$', '', 'g')) AS text_len,
            ts_headline('english', picked.text, (SELECT loose FROM qq), $2) AS snippet,
            -- Exact coverage length, not a heuristic one. Stripping "**" from
            -- the marked snippet in JS also strips "**" that occurs IN THE
            -- SOURCE TEXT, corrupting the comparison (see SNIPPET_COVERAGE_OPTS'
            -- comment). This second ts_headline call, same options minus the
            -- markers, extracts the identical fragments with nothing to strip.
            length(ts_headline('english', picked.text, (SELECT loose FROM qq), $8)) AS coverage_len
       FROM picked
       JOIN documents d ON d.tenant = $6 AND d.id = picked.doc_id
      ORDER BY rank DESC, doc_id`,
    [
      query,
      SNIPPET_OPTS,
      limit * 3,
      viewer.principal,
      viewer.groups,
      viewer.tenant,
      sources,
      SNIPPET_COVERAGE_OPTS,
    ],
  );

  const byDoc = new Map<string, SearchResult & { updated: Date | null }>();
  // Four lexical lists: {prose, code} x {matched every term, matched any term}.
  const lists: Record<string, string[]> = {
    fts_prose: [],
    fts_prose_loose: [],
    fts_code: [],
    fts_code_loose: [],
  };
  for (const row of res.rows) {
    if (byDoc.has(row.doc_id)) continue;
    const snippet: string = row.snippet;
    // coverage_len is the marker-free extraction's length, computed in SQL —
    // exact, not a JS-side strip of "**" (which also strips literal "**" that
    // occurs in the source text; see SNIPPET_COVERAGE_OPTS' comment).
    const covered = Number(row.coverage_len) >= Number(row.text_len);
    byDoc.set(row.doc_id, {
      id: row.doc_id,
      title: row.title,
      url: row.url,
      tier: row.quality_tier,
      snippet,
      truncated: !covered,
      // Number() on both, for symmetry: correct today as-is (chunks.seq is
      // int, and pg driver returns it as a JS number already), latent-safe
      // if that column ever widens to bigint (returned as a string).
      section_index: Number(row.seq),
      section_count: Number(row.section_count),
      updated: row.updated_at,
    });
    const cls = row.source === "code" ? "fts_code" : "fts_prose";
    // A doc matching every term is deliberately placed in BOTH lists, so RRF
    // counts it twice and it outranks partial matches without needing a tuned
    // precision constant anywhere.
    if (row.strict_hit) lists[cls]!.push(row.doc_id);
    lists[`${cls}_loose`]!.push(row.doc_id);
  }
  // Separate arms is the actual fix for code crowding. RRF is rank-based, so an
  // inflated ts_rank inside a code arm can only ever outrank OTHER CODE — it
  // cannot evict prose from the result set, whatever the raw scores look like.
  const arms: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(lists)) if (ids.length > 0) arms[name] = ids;
  try {
    const vec = await vecArm(
      client,
      viewer,
      query,
      limit,
      byDoc,
      embedder,
      sources,
      includeSuperseded,
    );
    if (vec && vec.length > 0) arms.vec = vec;
  } catch (err: any) {
    console.error(`vec arm skipped: ${err.message}`); // best-effort: degrade to FTS-only
  }
  const fused = rrf(arms, armWeights(decision.route));
  const scored = fused
    .map(([docId, score]): [number, string] => {
      const entry = byDoc.get(docId)!;
      return [score * modifier(entry.tier, entry.updated), docId];
    })
    .sort(([sA, idA], [sB, idB]) => (sB !== sA ? sB - sA : idA < idB ? -1 : 1));

  const picked = scored.slice(0, limit);
  const results = picked.map(([score, docId]) => {
    const { updated: _updated, ...entry } = byDoc.get(docId)!;
    return { ...entry, score: Math.round(score * 1e6) / 1e6 };
  });
  // Bounds describe the evidence ACTUALLY returned, not the corpus: a document
  // that exists but did not match says nothing about this answer's freshness.
  const bounds = evidenceBounds(picked.map(([, docId]) => byDoc.get(docId)?.updated ?? null));
  const currentTo = await corpusCurrentTo(client, viewer.tenant);
  // Honesty about execution: path/symbol/exact routes still run through FTS
  // (specialized executors arrive with Zoekt/symbols) — the route only steers
  // arm weights today. `executor` names the arms that actually contributed, so
  // route ≠ executor stays visible, as does a silently-missing vector arm.
  return {
    route: decision.route,
    executor: Object.keys(arms).sort().join("+") || "none",
    results,
    ...bounds,
    corpus_current_to: currentTo,
    ...confidence(results, arms),
  };
}

/**
 * When the catalog itself last successfully synced, or null if it never has.
 *
 * `last_success_at` rather than `updated_at`: a connector failing every document
 * still touches its cursor row on every run, so `updated_at` reports a corpus
 * that has been broken for a week as perfectly fresh. Only a run that actually
 * landed a document may claim currency.
 *
 * Null is RETURNED, never omitted. A caller that cannot distinguish "never
 * synced" from "just synced" is exactly the no-data-reads-as-OK failure.
 */
async function corpusCurrentTo(client: Db, tenant: string): Promise<string | null> {
  // min(), not max(): currency for the tenant is the OLDEST successful sync,
  // because one freshly-synced scope would otherwise mask every stale one. A
  // corpus is only as current as its least current source.
  //
  // Null when there are no cursors at all, or when ANY cursor has never
  // succeeded — a source that has never landed a document has no currency to
  // average in, and treating it as absent would let the remaining sources
  // vouch for data that was never fetched.
  const res = await client.query(
    `SELECT CASE
              WHEN count(*) = 0 OR count(last_success_at) <> count(*) THEN NULL
              ELSE min(last_success_at)
            END AS t
       FROM sync_cursors WHERE tenant = $1`,
    [tenant],
  );
  const t = res.rows[0]?.t ?? null;
  return t ? new Date(t).toISOString() : null;
}

/**
 * Oldest and newest evidence under an answer.
 *
 * Two bounds, not one aggregate: a single `as_of` is ambiguous between "the
 * freshest thing I found" and "the oldest thing I am relying on", and on a real
 * corpus those differ by years. The oldest is the honest headline if a caller
 * needs exactly one number — a conclusion is only as current as the stalest
 * evidence beneath it.
 */
function evidenceBounds(stamps: Array<Date | null>): {
  evidence_as_of_oldest: string | null;
  evidence_as_of_newest: string | null;
} {
  const known = stamps.filter((d): d is Date => d instanceof Date);
  if (known.length === 0) return { evidence_as_of_oldest: null, evidence_as_of_newest: null };
  const times = known.map((d) => d.getTime());
  return {
    // One undated citation makes the WEAKEST bound unknown, not "the oldest
    // date I happen to have". Reporting the oldest known date while an undated
    // document sits in the same answer overstates freshness — precisely the
    // claim this field exists to prevent.
    evidence_as_of_oldest:
      known.length === stamps.length ? new Date(Math.min(...times)).toISOString() : null,
    // The newest known timestamp stays meaningful: something in this answer is
    // at least that recent, whatever else is undated.
    evidence_as_of_newest: new Date(Math.max(...times)).toISOString(),
  };
}

/** Postgres timestamps arrive as Date or string depending on driver path. */
function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Attach the answer-level freshness contract to a response shape that did not
 * go through searchDocsInner — currently the direct search_code tool.
 *
 * Exported so every answer path states AS-OF the same way. A guarantee one tool
 * quietly opts out of is not a guarantee.
 */
export async function attachFreshness<T extends Record<string, unknown>>(
  client: Db,
  viewer: Viewer,
  out: T,
  stamps: Array<string | null>,
): Promise<T & Record<string, unknown>> {
  return {
    ...out,
    ...evidenceBounds(stamps.map(toDate)),
    corpus_current_to: await corpusCurrentTo(client, viewer.tenant),
  };
}

/** Score gap below which a result set is worth re-querying rather than trusting. */
export const WEAK_SCORE_GAP = 0.05;

/**
 * Signals an agent can act on without a second model call.
 *
 * Self-RAG / CRAG / Adaptive-RAG all spend LLM tokens to answer one question:
 * "is this result set good enough, or should I search again?" Their measured
 * gains are real, but the expensive part is the deciding, and these four numbers
 * hand the caller the same evidence deterministically and for free:
 *
 *   top_score          absolute confidence in the best hit
 *   score_gap          top1 - top5; a flat set means nothing stood out
 *   n_above_threshold  how many results are near the top rather than tailing off
 *   arms_contributing  how many independent arms agreed — one arm is a weaker
 *                      signal than three, and a MISSING arm (the vector arm
 *                      silently degrading) shows up here rather than nowhere
 *
 * Deliberately descriptive, not prescriptive: EIL reports, the agent decides.
 */
function confidence(
  results: Array<{ score?: number }>,
  arms: Record<string, string[]>,
): Record<string, unknown> {
  if (results.length === 0) {
    return { top_score: 0, score_gap: 0, n_above_threshold: 0, arms_contributing: 0 };
  }
  const top = results[0]?.score ?? 0;
  const fifth = results[Math.min(4, results.length - 1)]?.score ?? 0;
  const cut = top * (1 - WEAK_SCORE_GAP);
  return {
    top_score: top,
    score_gap: Math.round((top - fifth) * 1e6) / 1e6,
    n_above_threshold: results.filter((r) => (r.score ?? 0) >= cut).length,
    arms_contributing: Object.keys(arms).length,
  };
}

export async function getDoc(
  client: Db,
  viewer: Viewer,
  docId: string,
  section = 0,
  maxChars: number = GET_DOC_MAX_CHARS,
  /** Retrieve a superseded document by its exact id. Off by default; see
   *  visibleSql for why only the validity clause is ever relaxed. */
  includeSuperseded = false,
): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `SELECT id, title, url, source, quality_tier, hierarchy, updated_at, valid_to, superseded_by, body
     FROM documents d WHERE id = $1 AND ${visibleSql(2, 3, 4, includeSuperseded)}`,
    [docId, viewer.principal, viewer.groups, viewer.tenant],
  );
  const row = res.rows[0];
  if (!row) return null;
  const body: string = row.body;
  const totalSections = Math.max(1, Math.ceil(body.length / maxChars));
  const base = {
    id: row.id,
    title: row.title,
    url: row.url,
    source: row.source,
    tier: row.quality_tier,
    hierarchy: row.hierarchy,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    // BYTE-PAGINATION page (GET_DOC_MAX_CHARS windows) — NOT a chunk index.
    // Do not merge with SearchResult's section_index/section_count
    // (ts/search.ts), which count CHUNKS: a 228-char, 5-chunk document is
    // total_sections:1 here (it fits one GET_DOC_MAX_CHARS window) but
    // section_count:5 there — same-shaped names, different units, and
    // merging them would put contradictory numbers in one conversation.
    section,
    total_sections: totalSections,
  };
  // An out-of-range section used to fall straight into
  // body.slice(start, start + maxChars) and come back "" silently —
  // indistinguishable from "this document has no content". A caller who read
  // search_docs' section_count (chunk count) and passed it here as `section`
  // (a byte-pagination page count) hit exactly this: no error, just an empty
  // body. Silence is the failure mode this whole task has been fighting —
  // make the caller's mistake visible instead of returning a body-shaped lie.
  if (section < 0 || section >= totalSections) {
    return {
      ...base,
      error: `section ${section} out of range — this document has ${totalSections} section(s): 0..${totalSections - 1}`,
      body: null,
    };
  }
  const start = section * maxChars;
  return { ...base, body: body.slice(start, start + maxChars) };
}

export async function expand(
  client: Db,
  viewer: Viewer,
  docId: string,
  limit: number = EXPAND_MAX_EDGES,
): Promise<{ id: string; edges: Edge[]; truncated: boolean }> {
  // Fail-closed on the FOCAL document first: expanding a restricted doc must
  // leak nothing — not even the ids its body references (dangling out-edges
  // would otherwise slip past the destination-side ACL check below).
  // The tenant must be anchored OUTSIDE the negation. Folding it into
  // visibleSql() and negating the whole conjunction made ANOTHER tenant's row
  // with the same canonical id satisfy `NOT(... AND d.tenant = $4)`, so expand
  // returned zero edges for a viewer fully entitled to their own copy — and the
  // entity route, which calls expand() for every jira:issue:* query, silently
  // returned linked: []. Negate only the principal/groups test.
  const restricted = await client.query(
    `SELECT 1 FROM documents d
      WHERE d.tenant = $4 AND d.id = $1
        AND NOT ((d.ingested_by = $2 OR d.acl_groups ?| $3::text[])
                 AND d.tombstoned_at IS NULL AND d.quarantined_at IS NULL)`,
    [docId, viewer.principal, viewer.groups, viewer.tenant],
  );
  if (restricted.rows.length > 0) return { id: docId, edges: [], truncated: false };

  // Destination-side visibility is fail-closed too. Dangling edges survive —
  // the focal doc is readable, so its extracted ids are fair game. Per-arm
  // LIMITs: a single trailing LIMIT would let a hub doc's in-edges starve
  // out-edges ('in' sorts before 'out').
  const res = await client.query(
    `(SELECT l.dst_id AS other, l.rel, 'out' AS direction, d.title
      FROM links l LEFT JOIN documents d ON d.tenant = l.tenant AND d.id = l.dst_id
      WHERE l.tenant = $4 AND l.src_id = $1 AND (d.id IS NULL OR ${visibleSql(2, 3, 4)})
      ORDER BY other LIMIT $5)
     UNION ALL
     (SELECT l.src_id AS other, l.rel, 'in' AS direction, d.title
      FROM links l LEFT JOIN documents d ON d.tenant = l.tenant AND d.id = l.src_id
      WHERE l.tenant = $4 AND l.dst_id = $1 AND (d.id IS NULL OR ${visibleSql(2, 3, 4)})
      ORDER BY other LIMIT $5)
     ORDER BY direction, other`,
    [docId, viewer.principal, viewer.groups, viewer.tenant, limit],
  );
  const edges: Edge[] = res.rows.map((row) => ({
    id: row.other,
    rel: row.rel,
    direction: row.direction,
    title: row.title,
    ingested: row.title !== null,
  }));
  const perArm = { in: 0, out: 0 };
  for (const e of edges) perArm[e.direction] += 1;
  return { id: docId, edges, truncated: Math.max(perArm.in, perArm.out) >= limit };
}

/** What a tool call did, beyond who called it. `route` and `executor` are
 *  computed by searchDocs and were previously discarded; persisting them is what
 *  makes arm contribution and route-vs-executor drift visible. */
export interface AuditFacts {
  resultCount: number;
  durationMs: number;
  ok: boolean;
  // Explicitly `| undefined`: the repo runs exactOptionalPropertyTypes, and this
  // object is assembled programmatically in a finally block where these are
  // genuinely absent rather than merely omitted.
  error?: string | undefined;
  route?: string | undefined;
  executor?: string | undefined;
  traceId?: string | undefined;
}

export async function audit(
  client: Db,
  viewer: Viewer,
  tool: string,
  args: Record<string, unknown>,
  facts: AuditFacts,
): Promise<void> {
  await client.query(
    "INSERT INTO audit_log (tenant, principal, tool, args, result_count," +
      " duration_ms, ok, error, route, executor, trace_id)" +
      " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    [
      viewer.tenant,
      viewer.principal,
      tool,
      JSON.stringify(args),
      facts.resultCount,
      facts.durationMs,
      facts.ok,
      facts.error ?? null,
      facts.route ?? null,
      facts.executor ?? null,
      facts.traceId ?? null,
    ],
  );
}

/** Query -> ranked ids, for eval replay and implicit relevance. Best-effort:
 *  a failure here must never fail the search that produced it. */
export async function recordRetrieval(
  client: Db,
  viewer: Viewer,
  traceId: string,
  query: string,
  result: Record<string, unknown>,
): Promise<void> {
  const rows = Array.isArray(result.results) ? result.results : [];
  if (rows.length === 0) return;
  const returned = rows.map((r: any, i: number) => ({
    doc_id: r.id ?? r.docId ?? null,
    rank: i,
    score: r.score ?? null,
  }));
  try {
    await client.query(
      "INSERT INTO retrieval_events (trace_id, tenant, principal, query, route, executor, returned)" +
        " VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        traceId,
        viewer.tenant,
        viewer.principal,
        query,
        (result.route as string) ?? null,
        (result.executor as string) ?? null,
        JSON.stringify(returned),
      ],
    );
  } catch (err: any) {
    console.error(`retrieval_events skipped: ${err.message}`);
  }
}

/**
 * Cut `text` to at most `maxChars`, without splitting a UTF-16 surrogate pair
 * (an emoji or other astral character would otherwise come back as one half
 * of a broken glyph) and without cutting the last word in half (a raw
 * `.slice()` cut a chunk of arbitrary prose at whatever byte the budget landed
 * on, mid-word as often as not). Falls back to the raw cut when the budget
 * does not even reach one whitespace-delimited token, so a single very long
 * token is not collapsed to nothing.
 */
export function sliceSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const code = text.charCodeAt(end);
  if (code >= 0xdc00 && code <= 0xdfff) end -= 1; // low surrogate: back up over the pair
  const cut = text.slice(0, end);
  const trimmed = cut.replace(/\S*$/, "").trimEnd();
  return trimmed.length > 0 ? trimmed : cut;
}

/** Best-effort semantic arm: cosine over ACL-visible embedded chunks, scored
 *  IN Postgres (vectors are unit-norm, so cosine is a dot product) and cut to
 *  the candidate count there — only the winners are transferred. Returns a
 *  ranked docId list (best chunk per doc) and augments `byDoc` for vec-only
 *  docs. Returns null when nothing is embedded. Reuses visibleSql for ACL. */
async function vecArm(
  client: Db,
  viewer: Viewer,
  query: string,
  limit: number,
  byDoc: Map<string, SearchResult & { updated: Date | null }>,
  embedder?: Embedder,
  sources: string[] | null = null,
  includeSuperseded = false,
): Promise<string[] | null> {
  // Build the embedder first (construction is cheap — the local model loads
  // lazily on embed(), not here). May throw if a provider is misconfigured ->
  // caught by the caller -> FTS-only.
  const emb = embedder ?? getEmbedder();
  // Only cosine against chunks embedded by the SAME model — a query embedded with
  // model A vs chunks stored under model B (different dim/space) yields a finite
  // but meaningless score. Matching on embed_model makes a model switch
  // self-correcting: it degrades to FTS-only until `embed backfill --reembed`,
  // and lets us skip embedding the query when nothing matches.
  // Scoped to the viewer's tenant: an unscoped probe made a tenant with nothing
  // embedded still pay for a query-embedding call on every single search,
  // because some OTHER tenant had embeddings.
  // Two existence probes, deliberately in ONE round-trip: "is anything embedded
  // under this model for this tenant" (below, the pure-FTS short-circuit) and
  // "does any of it actually carry a cluster assignment" (the probing guard,
  // further down). The second question has to be answered BEFORE `probes` is
  // set, and folding it into the round-trip the first one already costs keeps
  // the hot path at the same number of queries it had before the guard existed.
  // Both are LIMIT-1 existence checks against chunk_vectors' own indexes
  // (chunk_vectors_model_idx and chunk_vectors_ivf_idx, migration 0020), not
  // counts.
  const state = await client.query(
    "SELECT EXISTS (SELECT 1 FROM chunk_vectors WHERE tenant = $2 AND embed_model = $1)" +
      "         AS embedded," +
      "       EXISTS (SELECT 1 FROM chunk_vectors WHERE tenant = $2 AND embed_model = $1" +
      "                 AND cluster_id IS NOT NULL) AS clustered",
    [emb.id, viewer.tenant],
  );
  if (!state.rows[0].embedded) return null; // nothing embedded with this model -> pure FTS
  const clustered = state.rows[0].clustered as boolean;
  // Stored vectors are unit-normalized (migration 0008 / toVec), so normalizing
  // the query too makes a dot product exactly equal to cosine — which is what
  // lets the scoring run in SQL instead of dragging every vector into Node.
  const qv = toVec((await emb.embed([query]))[0]!);
  // Probe list, or null when the coarse index is not built/calibrated. nprobe is
  // never a constant here — it is whatever the calibration run chose against the
  // recall gate, so a corpus whose geometry does not suit IVF simply keeps the
  // exact scan rather than silently losing recall.
  //
  // oversample rides along with it: it is calibrated in the SAME run and
  // persisted in the SAME metrics.ivf_calibration row (chosenOversample() reads
  // the `oversample` column off the row `chosen` marks), so using the constant
  // here once `chosenNprobe` had already gone dynamic was a worst-case default
  // baked into every query regardless of what THIS corpus's calibration found.
  // It only matters when probes is non-null: oversample bounds `cand` only in
  // the CASE branch that fires when $7 (probes) is non-null (see the query
  // below), so an uncalibrated corpus never reads it.
  //
  // `clustered` is the structural guard on all of this. The invariant this
  // function claims about itself — "the index is an optimisation, never a
  // correctness dependency" — used to be enforced by enumerating the writers
  // that could break it, and three separate doors to the SAME failure were
  // found one at a time: buildCentroids() replacing centroids under a live
  // calibration (closed by superseding inside the swap transaction, fix round
  // 2), backfill(..., {reembed: true}) rewriting every vector with a NULL
  // cluster_id (closed by superseding before the writes, fix round 3), and
  // backfill()'s per-chunk DELETE, which is scoped by (tenant, doc_id, seq)
  // and NOT by embed_model — deliberately, because chunk_vectors' PK has no
  // model column and a model-scoped delete collides at ord 0 — so a plain,
  // non-reembed backfill after a model switch also rewrites the corpus with
  // NULL cluster_id while leaving that model's calibration and centroids
  // standing. In every one of those states `probes` came back non-null,
  // `v.cluster_id = ANY($7)` matched nothing (NULL = ANY(...) is never true),
  // and the vector arm returned ZERO rows silently: no error, no log, just
  // `executor` quietly dropping "vec" and search narrowing to FTS-only.
  //
  // So the query path now refuses to probe an index the data does not carry,
  // rather than trusting every writer to have superseded correctly. This is an
  // EXISTENCE check, not a completeness one: a corpus mid-assignClusters has
  // some cluster_ids and probing it would still miss the unassigned tail —
  // that window is covered by the calibration being superseded for its whole
  // duration (buildCentroids() supersedes, and assignClusters() runs after it
  // commits), not by this guard.
  let probes: number[] | null = null;
  let oversample = OVERSAMPLE;
  if (clustered) {
    try {
      const { chosenNprobe, chosenOversample } = await import("./embed/buildivf.js");
      const nprobe = await chosenNprobe(client, emb.id);
      if (nprobe) {
        const cents = await loadCentroids(client, emb.id);
        if (cents.length > 0) probes = probeClusters(qv, cents, nprobe);
        const calibrated = await chosenOversample(client, emb.id);
        if (calibrated) oversample = calibrated;
      }
    } catch (err: any) {
      console.error(`ivf probe skipped: ${err.message}`); // degrade to exact scan
    }
  }
  // Score, reduce to the best chunk per doc, and cut to the candidate count all
  // inside Postgres, so only the winners cross the wire. `text` is deliberately
  // NOT selected until the final join — it dominated the old transfer.
  const res = await client.query(
    // The funnel. When a calibrated IVF index exists, `cand` narrows to the
    // probed clusters and orders by Hamming distance on the bit signature —
    // measured 1.30 us/WINDOW against 298.5 for the exact product, and
    // 0.17 us/WINDOW once clustering narrows it. These were measured back when
    // one row meant one chunk; migration 0020 moved the row grain to one row
    // per embedder window (~4 windows per max-size 3200-char chunk), so the
    // same per-row cost now covers roughly a quarter as many chunks as before.
    // Only the survivors get the exact float dot product, which is what
    // recovers the recall binary quantization loses (63.5% alone, 100% after
    // rescore).
    //
    // With no centroids, no calibration, or no cluster assignments (see the
    // `clustered` guard above), $7 is NULL and this degrades to exactly the
    // previous full exact scan — correct, just slow. The index is an
    // optimisation, never a correctness dependency.
    `WITH cand AS (
       SELECT v.doc_id, v.seq, v.ord, v.embedding
         FROM chunk_vectors v JOIN documents d ON d.tenant = v.tenant AND d.id = v.doc_id
        WHERE v.embed_model = $5 AND ${visibleSql(1, 2, 3, includeSuperseded)}
          AND ($7::int[] IS NULL OR v.cluster_id = ANY($7::int[]))
          AND ($11::text[] IS NULL OR d.source = ANY($11::text[]))
        ORDER BY CASE WHEN $8::varbit IS NULL OR v.sig IS NULL THEN 0
                      ELSE bit_count(v.sig # $8::varbit) END,
                 v.doc_id, v.seq, v.ord
        LIMIT CASE WHEN $7::int[] IS NULL THEN $9::bigint ELSE $10::bigint END
     ), scored AS (
       SELECT c.doc_id, c.seq,
              (SELECT sum(a::float8 * b::float8)
                 FROM unnest(c.embedding, $4::float4[]) AS t(a, b)) AS score
         FROM cand c
     ), best AS (
       SELECT DISTINCT ON (doc_id) doc_id, seq, score
         FROM scored ORDER BY doc_id, score DESC, seq
     ), top AS (
       SELECT doc_id, seq, score FROM best ORDER BY score DESC, doc_id LIMIT $6
     )
     -- length(d.body), NOT length(ch.text): truncated has to describe the
     -- DOCUMENT get_doc would return, not the one matched chunk — same
     -- reasoning as the lexical arm's doc_len above. This documents-d join
     -- reads no NEW rows: every doc_id here already passed visibleSql() inside
     -- cand, so this is re-joining an already-ACL-cleared id for its length,
     -- not a second unguarded read. section_count runs on top, which is
     -- already cut to LIMIT $6 (~limit*3) — the same post-cut placement as
     -- doc_len, not the pre-cut mistake that placement was fixing.
     SELECT t.doc_id, t.score, t.seq, ch.text, d.title, d.url, d.quality_tier, d.updated_at,
            length(d.body) AS doc_len,
            (SELECT count(*) FROM chunks ch2
              WHERE ch2.tenant = $3 AND ch2.doc_id = t.doc_id) AS section_count
       FROM top t
       JOIN chunks ch ON ch.tenant = $3 AND ch.doc_id = t.doc_id AND ch.seq = t.seq
       JOIN documents d ON d.tenant = $3 AND d.id = t.doc_id
      ORDER BY t.score DESC, t.doc_id`,
    [
      viewer.principal,
      viewer.groups,
      viewer.tenant,
      qv,
      emb.id,
      limit * 3,
      probes, // null => no IVF index, scan everything (previous behaviour)
      probes ? signature(qv) : null,
      Number.MAX_SAFE_INTEGER, // unbounded when there is nothing to narrow with
      limit * oversample, // survivors handed to the exact rescore
      sources,
    ],
  );
  for (const row of res.rows) {
    if (!byDoc.has(row.doc_id)) {
      const text = String(row.text);
      // No query terms to bias toward on this arm — the match was semantic — so
      // this is a leading extract, not a headline. VEC_SNIPPET_CHARS is
      // calibrated against the LEXICAL arm's measured worst case, not an exact
      // match (see the VEC_SNIPPET_CHARS comment), so the two arms land in the
      // same ballpark rather than byte-identical.
      const snippet = sliceSnippet(text, VEC_SNIPPET_CHARS);
      // `truncated` describes the DOCUMENT, not the matched chunk (`text`) —
      // same C1 reasoning as the lexical arm. Comparing against the RAW
      // (untrimmed) doc_len is deliberately the stricter bound here: this arm
      // does not run ts_headline, so it carries none of that function's
      // trailing-punctuation loss to compensate for, and a stricter bound only
      // ever pushes an uncertain case toward truncated:true, never the reverse.
      byDoc.set(row.doc_id, {
        id: row.doc_id,
        title: row.title,
        url: row.url,
        tier: row.quality_tier,
        snippet,
        truncated: snippet.length < Number(row.doc_len),
        // Number() on both, for symmetry with the lexical arm — see its comment.
        section_index: Number(row.seq),
        section_count: Number(row.section_count),
        updated: row.updated_at,
      });
    }
  }
  return res.rows.map((r) => r.doc_id as string);
}
