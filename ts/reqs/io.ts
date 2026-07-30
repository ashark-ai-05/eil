/**
 * The artefact's edges: reading a `reqs.json` off disk, writing one back, and
 * the ONE resolver that lets the analyser leave the artefact.
 *
 * `makeDocResolver` fetches every cited document through
 * `callTool("get_doc", ...)` rather than querying `documents` directly. That is
 * not incidental plumbing — it is what makes CLARIFY-005 mean something:
 *   - the fetch inherits the caller's ACL viewer, so a citation to a document
 *     the caller may not read RESOLVES TO NULL and therefore FAILS the check,
 *     instead of quietly verifying against text the caller was never entitled
 *     to see;
 *   - every verification lands an audited row with a trace id, so "we checked
 *     this citation" is a fact in the database rather than a claim in a log.
 * A raw SQL read would silently lose both properties.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { Db } from "../db.js";
import type { Viewer } from "../search.js";
import { type ReqsBody, parseReqs } from "./schema.js";

/**
 * `get_doc` windows large bodies (8k chars a section) and reports
 * `total_sections`. A verbatim quote can sit in any window, so the resolver
 * reassembles the document rather than verifying against its first page only —
 * capped, because verification must not be turned into a corpus download.
 */
const MAX_SECTIONS = 20;

/** Read a file as JSON with a message a presenter can act on. */
export async function loadRawReqs(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err: any) {
    throw new Error(
      err?.code === "ENOENT"
        ? `no such file: ${path}`
        : `cannot read ${path}: ${err?.message ?? String(err)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err: any) {
    throw new Error(`${path} is not valid JSON: ${err?.message ?? String(err)}`);
  }
}

/**
 * Read and validate. Callers that must PROJECT the body (render) need it typed,
 * so an unparseable body is an error here. `check` deliberately does NOT use
 * this: it hands the raw value to the analyser, which turns schema violations
 * into SCHEMA findings — a refusal that names itself beats a stack trace.
 */
export async function loadReqs(path: string): Promise<ReqsBody> {
  const parsed = parseReqs(await loadRawReqs(path));
  if (!parsed.ok) {
    throw new Error(
      `${path} does not match the reqs schema:\n${parsed.issues.map((i) => `  ${i}`).join("\n")}`,
    );
  }
  return parsed.body;
}

/** Pretty-printed, newline-terminated: the canonical form is diffable and the
 * file is a well-behaved text file. */
export async function saveReqs(path: string, body: ReqsBody): Promise<void> {
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
}

/**
 * The live citation resolver. Returns the cited document's text, or `null` when
 * it does not exist OR the viewer cannot see it — CLARIFY-005 treats `null` as
 * an error, which is exactly the fail-closed behaviour we want: "we could not
 * check it" is the state a fabricated citation is indistinguishable from.
 */
export function makeDocResolver(
  client: Db,
  viewer: Viewer,
): (docId: string) => Promise<string | null> {
  return async (docId: string): Promise<string | null> => {
    // Lazily imported so this module stays cheap for callers that only need
    // load/save, matching the CLI's own import discipline.
    const { callTool } = await import("../tools.js");
    try {
      // The client is passed in, so callTool reuses this connection instead of
      // opening (and closing) one per cited document.
      const first = await callTool("get_doc", { id: docId }, viewer, client);
      // `{ error: "not found: <id>" }` covers both "absent" and "invisible" —
      // the tool refuses to distinguish them, so neither does this.
      if (typeof first.error === "string" || typeof first.body !== "string") return null;
      const total = typeof first.total_sections === "number" ? first.total_sections : 1;
      let text = first.body;
      for (let section = 1; section < Math.min(total, MAX_SECTIONS); section++) {
        const next = await callTool("get_doc", { id: docId, section }, viewer, client);
        if (typeof next.body !== "string") break;
        text += next.body;
      }
      return text;
    } catch (err: any) {
      // A catalog that throws mid-run (an unmigrated schema, a dropped
      // connection) must not take the gate down with it, and must not be
      // rewarded with a pass either: unverifiable is unverifiable, so this is
      // still `null` and CLARIFY-005 still refuses. The CAUSE goes to stderr,
      // where it cannot be mistaken for a finding, because "could not be
      // resolved" and "your database needs migrating" want different fixes.
      const cause = String(err?.message ?? err).split("\n")[0];
      const hint = "unverifiable (is the catalog migrated? try `eil db migrate`)";
      console.error(`get_doc(${docId}) failed: ${cause} — citation treated as ${hint}`);
      return null;
    }
  };
}
