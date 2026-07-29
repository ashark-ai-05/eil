/**
 * Rule-based query router — no LLM interprets queries, ever.
 * Developer queries are heavily patterned; unmatched queries fall through to
 * hybrid docs search.
 */

import { TICKET_SHAPE, isTicketKey } from "./ticket.js";

export type Route = "entity" | "path" | "symbol" | "exact" | "docs";

export interface Decision {
  route: Route;
  /** the token that triggered the rule, if any */
  match?: string;
}

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
  // isTicketKey, not the raw shape: "UTF-8 encoding" and "SHA-256 collisions"
  // matched the shape and were routed to the entity executor, which then did a
  // Jira lookup for a ticket that cannot exist instead of searching.
  const ticket = TICKET_SHAPE.exec(q);
  if (ticket && isTicketKey(ticket[1]!)) return { route: "entity", match: ticket[1]! };
  const path = PATH_RE.exec(q);
  if (path) return { route: "path", match: path[1]! };
  const quoted = QUOTED_RE.exec(q);
  if (quoted) return { route: "exact", match: quoted[1]! };
  const errorish = ERRORISH_RE.exec(q);
  if (errorish) return { route: "exact", match: errorish[0] };
  if (!q.includes(" ") && identifierShaped(q)) return { route: "symbol", match: q };
  return { route: "docs" };
}
