/** Shared normalizer helpers: link extraction from markdown bodies. */

import { ticketKeys } from "../core/ticket.js";

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Ticket keys and [[wikilinks]] found in a body, as canonical ids (deduped, self excluded). */
export function extractLinks(body: string, selfId: string): string[] {
  const links: string[] = [];
  for (const key of ticketKeys(body)) links.push(`jira:issue:${key}`);
  for (const m of body.matchAll(WIKILINK_RE)) links.push(`obsidian:note:${m[1]!.trim()}`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of links) {
    if (link !== selfId && !seen.has(link)) {
      seen.add(link);
      out.push(link);
    }
  }
  return out;
}
