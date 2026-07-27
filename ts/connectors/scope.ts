/**
 * Selection granularity for live ingestion. Pure: turns CLI flags into atomic
 * Scopes, each with its own incremental cursor key and CQL/JQL predicate.
 * One selector family per run; --query is a raw escape hatch. See
 * docs/superpowers/specs/2026-07-28-scoped-ingestion-design.md.
 */

import { createHash } from "node:crypto";

export type Scope =
  | { kind: "all" }
  | { kind: "space"; key: string }
  | { kind: "project"; key: string }
  | { kind: "pages"; ids: string[]; withDescendants: boolean }
  | { kind: "issues"; keys: string[] }
  | { kind: "query"; q: string };

function splitList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function validated(values: string[], re: RegExp, what: string): string[] {
  for (const v of values) {
    if (!re.test(v)) throw new Error(`invalid ${what}: ${v}`);
  }
  return values;
}

const SPACE_KEY = /^[A-Za-z0-9_-]+$/;
const PAGE_ID = /^\d+$/;
const PROJECT_KEY = /^[A-Za-z0-9_-]+$/;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export interface ConfluenceScopeOpts {
  space?: string;
  page?: string;
  query?: string;
  withDescendants?: boolean;
  reconcile?: boolean;
  fixture?: string;
}

export function parseConfluenceScopes(opts: ConfluenceScopeOpts): Scope[] {
  const families = [opts.space, opts.page, opts.query].filter((v) => v != null).length;
  if (families > 1) throw new Error("choose at most one of --space, --page, --query");
  if (opts.withDescendants && opts.page == null)
    throw new Error("--with-descendants requires --page");
  if (opts.reconcile && families > 0)
    throw new Error("--reconcile is only supported for full-instance sync (drop the selector)");
  if (opts.fixture && families > 0) throw new Error("--fixture cannot be combined with a selector");

  if (opts.space != null)
    return validated(splitList(opts.space), SPACE_KEY, "space key").map((key) => ({
      kind: "space",
      key,
    }));
  if (opts.page != null)
    return [
      {
        kind: "pages",
        ids: validated(splitList(opts.page), PAGE_ID, "page id"),
        withDescendants: !!opts.withDescendants,
      },
    ];
  if (opts.query != null) return [{ kind: "query", q: opts.query }];
  return [{ kind: "all" }];
}

export interface JiraScopeOpts {
  project?: string;
  issue?: string;
  query?: string;
  reconcile?: boolean;
  fixture?: string;
}

export function parseJiraScopes(opts: JiraScopeOpts): Scope[] {
  const families = [opts.project, opts.issue, opts.query].filter((v) => v != null).length;
  if (families > 1) throw new Error("choose at most one of --project, --issue, --query");
  if (opts.reconcile && families > 0)
    throw new Error("--reconcile is only supported for full-instance sync (drop the selector)");
  if (opts.fixture && families > 0) throw new Error("--fixture cannot be combined with a selector");

  if (opts.project != null)
    return validated(splitList(opts.project), PROJECT_KEY, "project key").map((key) => ({
      kind: "project",
      key,
    }));
  if (opts.issue != null)
    return [{ kind: "issues", keys: validated(splitList(opts.issue), ISSUE_KEY, "issue key") }];
  if (opts.query != null) return [{ kind: "query", q: opts.query }];
  return [{ kind: "all" }];
}

export function cursorKey(source: string, scope: Scope): string | null {
  switch (scope.kind) {
    case "all":
      return source;
    case "space":
      return `${source}:space:${scope.key}`;
    case "project":
      return `${source}:project:${scope.key}`;
    case "query":
      return `${source}:query:${createHash("sha1").update(scope.q).digest("hex").slice(0, 12)}`;
    case "pages":
    case "issues":
      return null;
  }
}

export function predicate(scope: Scope): string | null {
  switch (scope.kind) {
    case "space":
      return `space = "${scope.key}"`;
    case "project":
      return `project = "${scope.key}"`;
    case "query":
      // Escape-hatch trust boundary: the raw query is the user's own CQL/JQL,
      // run under their PAT (ACL-bounded) and never reaches a deletion path
      // (listIds/reconcile are full-instance only). Parenthesized so a
      // well-formed predicate composes; a malformed one only broadens/breaks
      // the user's own read — acceptable for a documented raw escape hatch.
      return `(${scope.q})`;
    case "all":
    case "pages":
    case "issues":
      return null;
  }
}
