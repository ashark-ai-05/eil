/**
 * Query execution: router -> executors -> fusion. The deterministic query path.
 * Every read is ACL-filtered server-side (fail-closed, on both the focal and
 * destination documents) — the predicate is never caller-controlled.
 */

import { userInfo } from "node:os";
import { rrf } from "./core/fusion.js";
import { modifier } from "./core/ranking.js";
import { classify } from "./core/router.js";
import type { Db } from "./db.js";

export const SNIPPET_OPTS = "StartSel=**, StopSel=**, MaxWords=40, MinWords=10";
export const GET_DOC_MAX_CHARS = 8_000;
export const EXPAND_MAX_EDGES = 50;

// Mandatory, fail-closed visibility: viewer ingested the doc OR shares an
// acl_groups stamp, AND (when the viewer is tenant-scoped) the doc belongs
// to that tenant. Only static $-indices ever reach SQL text.
const visibleSql = (principalIdx: number, groupsIdx: number, tenantIdx: number) =>
  `((d.ingested_by = $${principalIdx} OR d.acl_groups ?| $${groupsIdx}::text[])` +
  ` AND ($${tenantIdx}::text IS NULL OR d.tenant = $${tenantIdx}))`;

export interface Viewer {
  principal: string;
  groups: string[];
  /** When set, reads are scoped to this tenant; unset = no tenant filter. */
  tenant?: string;
}

const tenantOf = (viewer: Viewer): string | null => viewer.tenant ?? null;

/** Local mode: OS user + optional EIL_USER_GROUPS / EIL_TENANT. On kube: token claims. */
export function localViewer(): Viewer {
  const raw = process.env.EIL_USER_GROUPS ?? "";
  const viewer: Viewer = {
    principal: userInfo().username,
    groups: raw
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
  };
  if (process.env.EIL_TENANT) viewer.tenant = process.env.EIL_TENANT;
  return viewer;
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
): Promise<Record<string, unknown>> {
  const decision = classify(query);

  if (decision.route === "entity") {
    const entityId = `jira:issue:${decision.match}`;
    const doc = await getDoc(client, viewer, entityId, 0, 2_000);
    const neighborhood = await expand(client, viewer, entityId);
    return { route: "entity", entity: doc, linked: neighborhood.edges };
  }

  // v0: single lexical arm through Postgres FTS; a kNN arm joins here later
  // and rrf() already fuses however many arms exist.
  const res = await client.query(
    `SELECT c.doc_id, d.title, d.url, d.quality_tier, d.updated_at,
            ts_rank(c.tsv, websearch_to_tsquery('english', $1)) AS rank,
            ts_headline('english', c.text,
                        websearch_to_tsquery('english', $1), $2) AS snippet
     FROM chunks c JOIN documents d ON d.id = c.doc_id
     WHERE c.tsv @@ websearch_to_tsquery('english', $1) AND ${visibleSql(4, 5, 6)}
     ORDER BY rank DESC, c.doc_id, c.seq
     LIMIT $3`,
    [query, SNIPPET_OPTS, limit * 3, viewer.principal, viewer.groups, tenantOf(viewer)],
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
  const fused = rrf({ fts: [...byDoc.keys()] });
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
    [docId, viewer.principal, viewer.groups, tenantOf(viewer)],
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
    [docId, viewer.principal, viewer.groups, tenantOf(viewer)],
  );
  if (restricted.rows.length > 0) return { id: docId, edges: [], truncated: false };

  // Destination-side visibility is fail-closed too. Dangling edges survive —
  // the focal doc is readable, so its extracted ids are fair game. Per-arm
  // LIMITs: a single trailing LIMIT would let a hub doc's in-edges starve
  // out-edges ('in' sorts before 'out').
  const res = await client.query(
    `(SELECT l.dst_id AS other, l.rel, 'out' AS direction, d.title
      FROM links l LEFT JOIN documents d ON d.id = l.dst_id
      WHERE l.src_id = $1 AND (d.id IS NULL OR ${visibleSql(2, 3, 4)})
      ORDER BY other LIMIT $5)
     UNION ALL
     (SELECT l.src_id AS other, l.rel, 'in' AS direction, d.title
      FROM links l LEFT JOIN documents d ON d.id = l.src_id
      WHERE l.dst_id = $1 AND (d.id IS NULL OR ${visibleSql(2, 3, 4)})
      ORDER BY other LIMIT $5)
     ORDER BY direction, other`,
    [docId, viewer.principal, viewer.groups, tenantOf(viewer), limit],
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
  principal: string,
  tool: string,
  args: Record<string, unknown>,
  resultCount: number,
): Promise<void> {
  await client.query(
    "INSERT INTO audit_log (principal, tool, args, result_count) VALUES ($1, $2, $3, $4)",
    [principal, tool, JSON.stringify(args), resultCount],
  );
}
