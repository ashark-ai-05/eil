/**
 * Split a chunk into embedder-sized windows.
 *
 * chunker.MAX_CHARS is 3200; the vendored MiniLM-L6 reads 1024 (256 tokens at
 * ~4 chars/token). One vector per chunk therefore embedded the first third and
 * silently ignored the rest — measured, two 3200-char texts differing only past
 * ~1600 chars produce cosine 1.000000. quality.ts has been counting the affected
 * chunks as `chunks_over_embed_window` without anything acting on it.
 *
 * The heading breadcrumb is repeated on EVERY window rather than only the first.
 * It is what makes a window interpretable in isolation, which is exactly why
 * backfill prepends it today, and dropping it after window 0 would make the tail
 * windows worse than the head one for no saving.
 *
 * Windows overlap so a sentence spanning a boundary still appears whole in one
 * of them. TREC's Podcasts track used 50% overlap on ~340-word segments; 25% is
 * the cheaper end of that range and keeps the vector count at ~4 per max chunk.
 */

export const WINDOW_OVERLAP = 0.25;

export function embedWindows(headingPath: string, text: string, windowChars: number): string[] {
  const join = (t: string) => (headingPath ? `${headingPath}\n\n${t}` : t);
  // A non-finite window is the hash/HTTP embedder saying "I read everything".
  // Windowing it would multiply cost for no gain.
  if (!Number.isFinite(windowChars) || windowChars <= 0) return [join(text)];

  const cap = Math.floor(windowChars);
  // The breadcrumb may not eat the window. Past half, a window carries more
  // context than content and every window in the chunk embeds to nearly the
  // same vector — the exact failure this function exists to remove.
  const half = Math.max(1, Math.floor(cap / 2));
  let prefix = headingPath ? `${headingPath}\n\n` : "";
  if (prefix.length > half) prefix = `${headingPath.slice(0, Math.max(1, half - 2))}\n\n`;

  const budget = cap - prefix.length;
  if (budget <= 0) return [prefix];
  if (text.length <= budget) return [prefix + text];

  const step = Math.max(1, Math.floor(budget * (1 - WINDOW_OVERLAP)));
  const out: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    out.push(prefix + text.slice(start, start + budget));
    if (start + budget >= text.length) break;
  }
  return out;
}
