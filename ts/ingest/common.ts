/** Shared normalizer helpers: link extraction from markdown bodies. */

import { ticketKeys } from "../core/ticket.js";

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * URLs pointing back into the sources EIL already indexes.
 *
 * There was NO url matcher at all, so a Confluence page linked from a Jira
 * description produced zero edges — the single most common cross-source
 * reference in a real corpus, and the one the link graph exists to carry. Ticket
 * keys were the only cross-source signal, which meant the graph only ever
 * pointed one way.
 *
 * Host-agnostic on purpose: EIL is configured with one Confluence and one Jira,
 * so a Confluence-shaped URL is the configured Confluence whatever host it
 * names. Matching on host would silently drop every link written against a
 * vanity domain, an internal alias, or the pre-migration hostname.
 */
const URL_PATTERNS: Array<{ re: RegExp; id: (m: RegExpMatchArray) => string }> = [
  // /pages/viewpage.action?pageId=12345
  {
    re: /https?:\/\/\S*?\/pages\/viewpage\.action\?pageId=(\d+)/gi,
    id: (m) => `confluence:page:${m[1]}`,
  },
  // /display/SPACE/Title  and  /spaces/SPACE/pages/12345/Title
  { re: /https?:\/\/\S*?\/spaces\/[^/\s]+\/pages\/(\d+)/gi, id: (m) => `confluence:page:${m[1]}` },
  // /browse/PAY-981
  { re: /https?:\/\/\S*?\/browse\/([A-Z][A-Z0-9]{1,9}-\d+)/g, id: (m) => `jira:issue:${m[1]}` },
];

/** Canonical ids referenced by URL in a body. */
export function extractUrlLinks(body: string): string[] {
  const out: string[] = [];
  for (const p of URL_PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of body.matchAll(p.re)) out.push(p.id(m));
  }
  return out;
}

/** Ticket keys and [[wikilinks]] found in a body, as canonical ids (deduped, self excluded). */
export function extractLinks(body: string, selfId: string): string[] {
  const links: string[] = [];
  for (const key of ticketKeys(body)) links.push(`jira:issue:${key}`);
  links.push(...extractUrlLinks(body));
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
