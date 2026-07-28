/**
 * Query execution: router -> executors -> fusion. The deterministic query path.
 * Every read is ACL-filtered server-side (fail-closed, on both the focal and
 * destination documents) — the predicate is never caller-controlled.
 */

import { userInfo } from "node:os";
import { z } from "zod";
import { rrf } from "./core/fusion.js";
import { modifier } from "./core/ranking.js";
import { classify } from "./core/router.js";
import type { Db } from "./db.js";
import { type Embedder, getEmbedder, toVec } from "./embed/index.js";

export const SNIPPET_OPTS = "StartSel=**, StopSel=**, MaxWords=40, MinWords=10";
export const GET_DOC_MAX_CHARS = 8_000;
export const EXPAND_MAX_EDGES = 50;

// Mandatory, fail-closed visibility: a request always has exactly one tenant.
// Only static $-indices ever reach SQL text.
const visibleSql = (principalIdx: number, groupsIdx: number, tenantIdx: number) =>
  `((d.ingested_by = $${principalIdx} OR d.acl_groups ?| $${groupsIdx}::text[])` +
  ` AND d.tenant = $${tenantIdx} AND d.tombstoned_at IS NULL)`;

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
export function localViewer(): Viewer {
  const raw = process.env.EIL_USER_GROUPS ?? "";
  return trustedViewer({
    principal: userInfo().username,
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
  score?: number;
}

export interface Edge {
  id: string;
  rel: string;
  direction: "in" | "out";
  title: string | null;
  ingested: boolean;
}

export async function searchDocs(
  client: Db,
  viewer: Viewer,
  query: string,
  limit = 8,
  embedder?: Embedder,
): Promise<Record<string, unknown>> {
  const decision = classify(query);

  if (decision.route === "entity") {
    const entityId = `jira:issue:${decision.match}`;
    const doc = await getDoc(client, viewer, entityId, 0, 2_000);
    const neighborhood = await expand(client, viewer, entityId);
    return { route: "entity", entity: doc, linked: neighborhood.edges };
  }
  if (decision.route === "path" || decision.route === "symbol" || decision.route === "exact") {
    const { searchCodeIndex } = await import("./code-search.js");
    const kind = decision.route === "exact" ? "literal" : decision.route;
    const code = await searchCodeIndex(client, viewer, {
      query: decision.match ?? query,
      kind,
      limit,
    });
    if (code.results.length > 0) return { route: decision.route, ...code };
  }

  // v0: single lexical arm through Postgres FTS; a kNN arm joins here later
  // and rrf() already fuses however many arms exist.
  const res = await client.query(
    `SELECT c.doc_id, d.title, d.url, d.quality_tier, d.updated_at,
            ts_rank(c.tsv, websearch_to_tsquery('english', $1)) AS rank,
            ts_headline('english', c.text,
                        websearch_to_tsquery('english', $1), $2) AS snippet
     FROM chunks c JOIN documents d ON d.tenant = c.tenant AND d.id = c.doc_id
     WHERE c.tsv @@ websearch_to_tsquery('english', $1) AND ${visibleSql(4, 5, 6)}
     ORDER BY rank DESC, c.doc_id, c.seq
     LIMIT $3`,
    [query, SNIPPET_OPTS, limit * 3, viewer.principal, viewer.groups, viewer.tenant],
  );

  const byDoc = new Map<string, SearchResult & { updated: Date | null }>();
  for (const row of res.rows) {
    if (!byDoc.has(row.doc_id)) {
      byDoc.set(row.doc_id, {
        id: row.doc_id,
        title: row.title,
        url: row.url,
        tier: row.quality_tier,
        snippet: row.snippet,
        updated: row.updated_at,
      });
    }
  }
  const arms: Record<string, string[]> = { fts: [...byDoc.keys()] };
  try {
    const vec = await vecArm(client, viewer, query, limit, byDoc, embedder);
    if (vec && vec.length > 0) arms.vec = vec;
  } catch (err: any) {
    console.error(`vec arm skipped: ${err.message}`); // best-effort: degrade to FTS-only
  }
  const fused = rrf(arms);
  const scored = fused
    .map(([docId, score]): [number, string] => {
      const entry = byDoc.get(docId)!;
      return [score * modifier(entry.tier, entry.updated), docId];
    })
    .sort(([sA, idA], [sB, idB]) => (sB !== sA ? sB - sA : idA < idB ? -1 : 1));

  const results = scored.slice(0, limit).map(([score, docId]) => {
    const { updated: _updated, ...entry } = byDoc.get(docId)!;
    return { ...entry, score: Math.round(score * 1e6) / 1e6 };
  });
  // Honesty about execution: path/symbol/exact routes currently fall through
  // to FTS (specialized executors arrive with Zoekt/symbols). The executor
  // field tells callers what actually ran, so route ≠ executor is visible.
  return { route: decision.route, executor: "fts", results };
}

export async function getDoc(
  client: Db,
  viewer: Viewer,
  docId: string,
  section = 0,
  maxChars: number = GET_DOC_MAX_CHARS,
): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `SELECT id, title, url, source, quality_tier, hierarchy, updated_at, body
     FROM documents d WHERE id = $1 AND ${visibleSql(2, 3, 4)}`,
    [docId, viewer.principal, viewer.groups, viewer.tenant],
  );
  const row = res.rows[0];
  if (!row) return null;
  const body: string = row.body;
  const start = section * maxChars;
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    source: row.source,
    tier: row.quality_tier,
    hierarchy: row.hierarchy,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    section,
    total_sections: Math.max(1, Math.ceil(body.length / maxChars)),
    body: body.slice(start, start + maxChars),
  };
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
  const restricted = await client.query(
    `SELECT 1 FROM documents d WHERE d.id = $1 AND NOT ${visibleSql(2, 3, 4)}`,
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

export async function audit(
  client: Db,
  viewer: Viewer,
  tool: string,
  args: Record<string, unknown>,
  resultCount: number,
): Promise<void> {
  await client.query(
    "INSERT INTO audit_log (tenant, principal, tool, args, result_count) VALUES ($1, $2, $3, $4, $5)",
    [viewer.tenant, viewer.principal, tool, JSON.stringify(args), resultCount],
  );
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
  const has = await client.query(
    "SELECT 1 FROM chunks WHERE embedding IS NOT NULL AND embed_model = $1 LIMIT 1",
    [emb.id],
  );
  if (has.rows.length === 0) return null; // nothing embedded with this model -> pure FTS
  // Stored vectors are unit-normalized (migration 0008 / toVec), so normalizing
  // the query too makes a dot product exactly equal to cosine — which is what
  // lets the scoring run in SQL instead of dragging every vector into Node.
  const qv = toVec((await emb.embed([query]))[0]!);
  // Score, reduce to the best chunk per doc, and cut to the candidate count all
  // inside Postgres, so only the winners cross the wire. `text` is deliberately
  // NOT selected until the final join — it dominated the old transfer.
  const res = await client.query(
    `WITH scored AS (
       SELECT c.doc_id, c.seq,
              (SELECT sum(a::float8 * b::float8)
                 FROM unnest(c.embedding, $4::float4[]) AS t(a, b)) AS score
         FROM chunks c JOIN documents d ON d.tenant = c.tenant AND d.id = c.doc_id
        WHERE c.embedding IS NOT NULL AND c.embed_model = $5 AND ${visibleSql(1, 2, 3)}
     ), best AS (
       SELECT DISTINCT ON (doc_id) doc_id, seq, score
         FROM scored ORDER BY doc_id, score DESC, seq
     ), top AS (
       SELECT doc_id, seq, score FROM best ORDER BY score DESC, doc_id LIMIT $6
     )
     SELECT t.doc_id, t.score, ch.text, d.title, d.url, d.quality_tier, d.updated_at
       FROM top t
       JOIN chunks ch ON ch.tenant = $3 AND ch.doc_id = t.doc_id AND ch.seq = t.seq
       JOIN documents d ON d.tenant = $3 AND d.id = t.doc_id
      ORDER BY t.score DESC, t.doc_id`,
    [viewer.principal, viewer.groups, viewer.tenant, qv, emb.id, limit * 3],
  );
  for (const row of res.rows) {
    if (!byDoc.has(row.doc_id)) {
      byDoc.set(row.doc_id, {
        id: row.doc_id,
        title: row.title,
        url: row.url,
        tier: row.quality_tier,
        snippet: String(row.text).slice(0, 240),
        updated: row.updated_at,
      });
    }
  }
  return res.rows.map((r) => r.doc_id as string);
}
