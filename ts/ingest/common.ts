/** Shared normalizer helpers: link extraction from markdown bodies. */

const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Ticket keys and [[wikilinks]] found in a body, as canonical ids (deduped, self excluded). */
export function extractLinks(body: string, selfId: string): string[] {
  const links: string[] = [];
  for (const m of body.matchAll(TICKET_RE)) links.push(`jira:issue:${m[1]}`);
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
