/**
 * Rule-based query router — no LLM interprets queries, ever.
 * Developer queries are heavily patterned; unmatched queries fall through to
 * hybrid docs search.
 */

export type Route = "entity" | "path" | "symbol" | "exact" | "docs";

export interface Decision {
  route: Route;
  /** the token that triggered the rule, if any */
  match?: string;
}

const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
const QUOTED_RE = /"([^"]{3,})"/;
const PATH_RE = /\b(\S+\/\S+\.\w{1,8}|\S+\.(?:java|py|go|ts|tsx|js|rb|kt|scala|sql))(?::\d+)?\b/;
const ERRORISH_RE = /\b\w*(?:Exception|Error)\b/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifierShaped(q: string): boolean {
  if (!IDENTIFIER_RE.test(q)) return false;
  const hasSnake = q.includes("_");
  const hasCamel = q !== q.toLowerCase() && q !== q.toUpperCase();
  return hasSnake || hasCamel;
}

export function classify(query: string): Decision {
  const q = query.trim();
  let m: RegExpExecArray | null;
  if ((m = TICKET_RE.exec(q))) return { route: "entity", match: m[1]! };
  if ((m = PATH_RE.exec(q))) return { route: "path", match: m[1]! };
  if ((m = QUOTED_RE.exec(q))) return { route: "exact", match: m[1]! };
  if ((m = ERRORISH_RE.exec(q))) return { route: "exact", match: m[0] };
  if (!q.includes(" ") && identifierShaped(q)) return { route: "symbol", match: q };
  return { route: "docs" };
}
