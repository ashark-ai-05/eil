/**
 * The connector registry: the single executable inventory of what EIL ingests.
 *
 * Before this, `ingestConfluenceScope` and `ingestJiraScope` were the same
 * thirty lines twice — same cursor read, same generator wrapper, same
 * `ingestDocs` call — differing only in which normalizer they imported and
 * which method fetched one item. Two copies of a cursor protocol is how the two
 * drift: a fix to one is not a fix to the other, and nothing in the type system
 * said they were ever supposed to agree.
 *
 * `ts/tools.ts` already solved this shape for the MCP surface — specs declared
 * once, registered in one map, cross-cutting concerns applied at a single choke
 * point. This is deliberately the same pattern for ingestion.
 *
 * Two properties make it a registry rather than a catalogue:
 *
 *  1. EXECUTABLE. Every declaration has a production consumer. The CLI resolves
 *     a spec and calls `runSource`; it does not construct clients, validate env,
 *     or call reconcile itself. A field nothing reads is a comment that looks
 *     like code, and it goes stale exactly like one.
 *
 *  2. ILLEGAL STATES UNREPRESENTABLE. Cursor kind and executor are one
 *     discriminated union, not an optional-property bag. A `none` source cannot
 *     declare an incremental listing, because a full-listing source that reads a
 *     stored cursor and calls an incremental API is not a misconfiguration to
 *     catch at runtime — it is a spec that should not compile.
 */

import type { Scope } from "../connectors/scope.js";
import { cursorKey, predicate } from "../connectors/scope.js";
import type { CanonicalDoc } from "../contracts/models.js";
import { connect } from "../db.js";
import { getCursor } from "../store.js";
import type { ConfluencePage } from "./confluence.js";
import { normalize as normalizeConfluence } from "./confluence.js";
import type { JiraIssue } from "./jira.js";
import { normalize as normalizeJira } from "./jira.js";
import type { ConfluenceLike, JiraLike } from "./pipeline.js";
import { ingestDocs, runReconcile } from "./pipeline.js";

/**
 * How a source resumes. The discriminant.
 *
 * `timestamp` — an ordered watermark; the next run asks for "everything since".
 * `revision`  — an opaque source-defined position, e.g. a commit sha.
 * `none`      — no resumable position; every run is a full listing.
 *
 * These are not three labels on one mechanism. A timestamp cursor can be rebased
 * to the earliest failed item; a revision cursor can only be held or advanced
 * whole; a `none` source cannot strand anything because it never skips. Each
 * demands a different runner, which is why the kind selects the runner in the
 * TYPE rather than riding alongside it as documentation.
 */
export type CursorKind = "timestamp" | "revision" | "none";

interface SpecBase {
  /** Canonical source name, and the join key for cursors, coverage families and
   *  reconcile. Enforced at runtime against every document the source emits. */
  name: string;
  description: string;
  /** What must be configured before this source can run live. Consumed by
   *  `runSource`, which refuses by name rather than letting a client
   *  constructor fail with a less specific message. */
  requiresEnv: string[];
}

/** Options every runner receives from the CLI. */
export interface RunOptions {
  tenant: string;
  /** Parsed scopes, for sources that have them. */
  scopes?: Scope[];
  /** Reconcile after a full sync: tombstone what the source no longer lists. */
  reconcile?: boolean;
  /** Path to a JSON fixture (one payload or a list). Offline mode: the source's
   *  own normalizer is applied, no client is built and no cursor is written. */
  fixture?: string;
  /** Source-specific CLI options, narrowed by each runner. */
  [k: string]: unknown;
}

/**
 * A source that resumes from an ordered watermark.
 *
 * `updatedSince` and `normalize` are REQUIRED here and absent from the other two
 * variants. That is the point of the union: a revision source cannot
 * accidentally declare an incremental listing and then silently never advance,
 * because there is no field to put it in.
 */
export interface TimestampSource<TRaw = unknown> extends SpecBase {
  cursor: "timestamp";
  makeClient: () => Promise<unknown>;
  normalize: (raw: TRaw, tenant: string) => CanonicalDoc;
  updatedSince: (client: unknown, cursor: string | null, pred?: string) => AsyncGenerator<TRaw>;
  /** The named-items escape hatch: fetch exactly these, write no cursor. */
  explicit?: {
    scopeKind: string;
    idsOf: (scope: Scope) => string[];
    fetch: (client: unknown, id: string, scope: Scope) => AsyncGenerator<TRaw>;
  };
  listIds: (client: unknown) => Promise<string[]>;
}

/**
 * A source that resumes from an opaque revision and runs its own file-oriented
 * ingest — it tombstones by subtree, maintains a separate symbol index, and
 * holds its cursor on any unreadable file. That cannot be the document-oriented
 * runner, which is why `revision` is a distinct variant rather than a label.
 */
export interface RevisionSource extends SpecBase {
  cursor: "revision";
  run: (opts: RunOptions) => Promise<void>;
}

/** A source with no resumable position: the listing IS the full inventory. */
export interface ListingSource extends SpecBase {
  cursor: "none";
  run: (opts: RunOptions) => Promise<void>;
}

export type SourceSpec = TimestampSource<any> | RevisionSource | ListingSource;

/**
 * Every document a source emits must carry that source's name.
 *
 * `name` is the join key for three subsystems — cursors are stored under it,
 * coverage groups families by it, reconcile tombstones by it — so a document
 * stamped with a different source ingests successfully and is then invisible to
 * every disclosure built on top of it. Checked rather than trusted, because the
 * `revision` and `none` runners receive already-built CanonicalDocs and no type
 * can tie those back to the spec that emitted them.
 */
export function assertSourceMatches(spec: SpecBase, doc: CanonicalDoc): CanonicalDoc {
  if (doc.source !== spec.name)
    throw new Error(
      `${spec.name}: emitted a document stamped source="${doc.source}" (${doc.id}). The spec name is the cursor/coverage/reconcile join key; a mismatch is silently uncitable.`,
    );
  return doc;
}

/**
 * Run one scope of a timestamp source.
 *
 * The single copy of the cursor protocol the two per-source functions used to
 * duplicate. Nothing about Confluence or Jira appears here by name. Typed to
 * `TimestampSource` specifically, so a revision or listing spec cannot reach it.
 */
export async function ingestScope<TRaw>(
  spec: TimestampSource<TRaw>,
  client: unknown,
  scope: Scope,
  tenant: string,
): Promise<void> {
  const explicit = spec.explicit;
  if (explicit && scope.kind === explicit.scopeKind) {
    const ids = explicit.idsOf(scope);
    console.log(`scope ${spec.name}:${scope.kind} [${ids.join(", ")}]`);
    const docs = (async function* () {
      for (const id of ids)
        for await (const raw of explicit.fetch(client, id, scope))
          yield assertSourceMatches(spec, spec.normalize(raw, tenant));
    })();
    // Explicit fetch writes no cursor: the caller named these items, so the run
    // says nothing about how far the source has been swept. Advancing a cursor
    // here would claim coverage that was never attempted.
    await ingestDocs(spec.name, docs, undefined, tenant);
    return;
  }

  const key = cursorKey(spec.name, scope);
  if (key === null) throw new Error(`unexpected non-cursor ${spec.name} scope: ${scope.kind}`);
  const db = await connect();
  const cursor = await getCursor(db, key, tenant);
  await db.end();
  console.log(`scope ${key} from cursor: ${cursor ?? "(beginning)"}`);

  const pred = predicate(scope) ?? undefined;
  const docs = (async function* () {
    for await (const raw of spec.updatedSince(client, cursor, pred))
      yield assertSourceMatches(spec, spec.normalize(raw, tenant));
  })();
  // A per-document watermark is meaningful only for a timestamp source, which is
  // why this is the only runner that passes one.
  await ingestDocs(key, docs, (d) => d.updatedAt ?? null, tenant);
}

/**
 * The production dispatcher. Every ingest command goes through here.
 *
 * Client construction, env validation, execution and reconcile all resolve from
 * the spec, so the CLI holds no per-source ingest knowledge and there is exactly
 * one inventory of sources rather than one in the registry and a second implied
 * by the set of commands.
 */
export async function runSource(spec: SourceSpec, opts: RunOptions): Promise<void> {
  /** Credentials are required to reach the SOURCE, so the gate belongs on the
   *  paths that do. Checking it up front would make `--fixture` demand
   *  credentials it never uses — offline fixture ingest is the one mode that
   *  must work with nothing configured at all. */
  const requireEnv = () => {
    const missing = spec.requiresEnv.filter((v) => !process.env[v]);
    if (missing.length > 0)
      throw new Error(
        `${spec.name}: live sync needs ${missing.join(" and ")} set (personal credentials)`,
      );
  };

  if (spec.cursor !== "timestamp") {
    requireEnv();
    await spec.run(opts);
    return;
  }

  // Fixture mode runs through the spec like everything else. It previously sat
  // in the CLI, importing the normalizer directly, which left per-source ingest
  // knowledge outside the registry and gave fixtures a second entry point that
  // no inventory check could see.
  //
  // It writes NO cursor: a hand-supplied file says nothing about how far the
  // real source has been swept, and advancing a cursor from one would claim
  // coverage that was never attempted. `ingestDocs` is still handed the tenant
  // rather than defaulting it — today `cursorOf` is undefined so the argument is
  // unreachable, but a cursor written into the wrong tenant is not a failure
  // worth leaving one edit away.
  if (opts.fixture) {
    const { readFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(opts.fixture, "utf-8"));
    const payloads: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const docs = payloads.map((p) =>
      assertSourceMatches(spec, spec.normalize(p as never, opts.tenant)),
    );
    await ingestDocs(spec.name, docs, undefined, opts.tenant);
    return;
  }

  requireEnv();
  const client = await spec.makeClient();
  for (const scope of opts.scopes ?? []) await ingestScope(spec, client, scope, opts.tenant);
  if (opts.reconcile)
    await runReconcile(
      spec.name,
      async () => ({ ids: await spec.listIds(client), complete: true }),
      opts.tenant,
    );
}

export const confluenceSpec: TimestampSource<ConfluencePage> = {
  name: "confluence",
  description: "Confluence pages via CQL, by space, page subtree, or raw predicate",
  cursor: "timestamp",
  requiresEnv: ["EIL_CONFLUENCE_URL", "EIL_CONFLUENCE_TOKEN"],
  makeClient: async () => {
    const { ConfluenceClient } = await import("../connectors/confluence.js");
    return new ConfluenceClient();
  },
  normalize: (raw, tenant) => normalizeConfluence(raw, tenant),
  updatedSince: (client, cursor, pred) => (client as ConfluenceLike).updatedSince(cursor, pred),
  explicit: {
    scopeKind: "pages",
    idsOf: (scope) => (scope as unknown as { ids: string[] }).ids,
    fetch: async function* (client, id, scope) {
      const c = client as ConfluenceLike;
      yield await c.getPage(id);
      // Descendants belong to the explicit fetch rather than a second command:
      // omitting the subtree when the caller passed --with-descendants is a
      // silent gap, and including it when they did not is a scope violation.
      if ((scope as unknown as { withDescendants?: boolean }).withDescendants)
        for await (const p of c.descendants(id)) yield p;
    },
  },
  listIds: (client) => (client as { listIds(): Promise<string[]> }).listIds(),
};

export const jiraSpec: TimestampSource<JiraIssue> = {
  name: "jira",
  description: "Jira issues via JQL, by project, issue key, or raw predicate",
  cursor: "timestamp",
  requiresEnv: ["EIL_JIRA_URL", "EIL_JIRA_TOKEN"],
  makeClient: async () => {
    const { JiraClient } = await import("../connectors/jira.js");
    return new JiraClient();
  },
  normalize: (raw, tenant) => normalizeJira(raw, tenant),
  updatedSince: (client, cursor, pred) => (client as JiraLike).updatedSince(cursor, pred),
  explicit: {
    scopeKind: "issues",
    idsOf: (scope) => (scope as unknown as { keys: string[] }).keys,
    fetch: async function* (client, id) {
      yield await (client as JiraLike).getIssue(id);
    },
  },
  listIds: (client) => (client as { listIds(): Promise<string[]> }).listIds(),
};

/**
 * A vault has no resumable position: the walk IS the full listing, so every run
 * sees everything and nothing can be stranded behind a cursor. Reconcile is
 * unconditional for the same reason — a full listing every run means a deletion
 * is detectable every run.
 */
export const obsidianSpec: ListingSource = {
  name: "obsidian",
  description: "An Obsidian vault of markdown files on local disk",
  cursor: "none",
  requiresEnv: [],
  run: async (opts) => {
    const { walkVault } = await import("./obsidian.js");
    const docs = walkVault(opts.vault as string, opts.tenant).map((d) =>
      assertSourceMatches(obsidianSpec, d),
    );
    await ingestDocs(obsidianSpec.name, docs, undefined, opts.tenant);
    await runReconcile(
      obsidianSpec.name,
      async () => ({ ids: docs.map((d) => d.id), complete: true }),
      opts.tenant,
    );
  },
};

export const codeSpec: RevisionSource = {
  name: "code",
  description: "Git repositories (clone or Bitbucket API) as code documents",
  cursor: "revision",
  // Empty rather than the Bitbucket variables: the same command legitimately
  // runs against a local clone with no credentials at all, so the requirement
  // is per-ref inside the runner rather than a blanket refusal here.
  requiresEnv: [],
  run: async (opts) => {
    const { ingestRepo } = await import("./pipeline.js");
    const { detectSource, repoKey } = await import("./code.js");
    const { GitCloneSource, BitbucketApiSource } = await import("../connectors/reposource.js");
    const { RepoFilter } = await import("./repofilter.js");
    // Commander hands through an untyped options object; each field is read
    // once, here.
    const o = opts as Record<string, any>;
    const filter = new RepoFilter({ includes: o.include, excludes: o.exclude });
    for (const ref of (opts.refs as string[]) ?? []) {
      const kind = o.source ?? detectSource(ref);
      const key = repoKey(ref, o.name);
      const cfg = { ref, branch: o.branch, subpath: o.subpath };
      if (kind === "bitbucket")
        for (const v of ["EIL_BITBUCKET_URL", "EIL_BITBUCKET_TOKEN"])
          if (!process.env[v]) throw new Error(`code: bitbucket ingest needs ${v} set`);
      const source = kind === "bitbucket" ? new BitbucketApiSource(cfg) : new GitCloneSource(cfg);
      console.log(`ingest ${kind} ${key} (${ref})`);
      await ingestRepo(source, key, o.subpath, filter, opts.tenant, o.aclGroup ?? []);
    }
  },
};

export const REGISTRY: Record<string, SourceSpec> = Object.fromEntries(
  [confluenceSpec, jiraSpec, obsidianSpec, codeSpec].map((s) => [s.name, s]),
);

/** Sources whose ingest runs through the generic scope path. Narrowed by the
 *  discriminant, so this cannot include a source that lacks the executor. */
export const scopedSources = (): TimestampSource<any>[] =>
  Object.values(REGISTRY).filter((s): s is TimestampSource<any> => s.cursor === "timestamp");
