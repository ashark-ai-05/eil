import type { Db } from "./db.js";
import type { Viewer } from "./search.js";
import type { CodeIndexKind } from "./ingest/codeindex.js";

export interface CodeSearchQuery {
  query: string;
  kind?: CodeIndexKind;
  repo?: string;
  ref?: string;
  path?: string;
  limit?: number;
}
export interface CodeCitation {
  docId: string;
  repo: string;
  path: string;
  ref: string;
  lineStart: number;
  lineEnd: number;
  kind: CodeIndexKind;
  matchedValue: string;
  text: string;
}
export interface CodeContextPack {
  citations: CodeCitation[];
  totalChars: number;
  truncated: boolean;
}
const lineWindow = (body: string, start: number, end: number, context = 3) => {
  const lines = body.split("\n");
  const from = Math.max(0, start - 1 - context),
    to = Math.min(lines.length, end + context);
  return lines.slice(from, to).join("\n");
};
/** Deterministic, ACL-filtered structural code lookup; no model/semantic arm. */
export async function searchCodeIndex(
  client: Db,
  viewer: Viewer,
  q: CodeSearchQuery,
): Promise<{ executor: "code_index"; results: CodeCitation[]; context: CodeContextPack }> {
  const limit = Math.min(q.limit ?? 8, 50),
    value = q.query.toLowerCase();
  const clauses = [
    "ci.tenant = $1",
    "(d.ingested_by = $2 OR d.acl_groups ?| $3::text[])",
    "d.tombstoned_at IS NULL",
    "ci.value = $4",
  ];
  const args: unknown[] = [viewer.tenant, viewer.principal, viewer.groups, value];
  if (q.kind) {
    args.push(q.kind);
    clauses.push(`ci.kind = $${args.length}`);
  }
  if (q.repo) {
    args.push(q.repo);
    clauses.push(`ci.repo = $${args.length}`);
  }
  if (q.ref) {
    args.push(q.ref);
    clauses.push(`ci.ref = $${args.length}`);
  }
  if (q.path) {
    args.push(q.path);
    clauses.push(`ci.path = $${args.length}`);
  }
  args.push(limit);
  const res = await client.query(
    `SELECT ci.doc_id,ci.repo,ci.path,ci.ref,ci.kind,ci.raw_value,ci.line_start,ci.line_end,d.body FROM code_index ci JOIN documents d ON d.tenant=ci.tenant AND d.id=ci.doc_id WHERE ${clauses.join(" AND ")} ORDER BY ci.path,ci.line_start,ci.kind LIMIT $${args.length}`,
    args,
  );
  const citations = res.rows.map(
    (r: any): CodeCitation => ({
      docId: r.doc_id,
      repo: r.repo,
      path: r.path,
      ref: r.ref,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      kind: r.kind,
      matchedValue: r.raw_value,
      text: lineWindow(r.body, r.line_start, r.line_end),
    }),
  );
  let total = 0,
    truncated = false;
  const bounded = citations.filter((c) => {
    if (total + c.text.length > 16000) {
      truncated = true;
      return false;
    }
    total += c.text.length;
    return true;
  });
  return {
    executor: "code_index",
    results: bounded,
    context: { citations: bounded, totalChars: total, truncated },
  };
}
