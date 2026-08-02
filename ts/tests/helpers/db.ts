/**
 * PGlite test harness for tests that need a real, migrated database. Mirrors
 * the setup in ts/tests/pglite.test.ts (tmp dir + connect + migrate, no
 * server) rather than inventing a second way to stand one up.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkHash, contentHash } from "../../contracts/models.js";
import { type Db, connect, migrate } from "../../db.js";
import type { Embedder } from "../../embed/index.js";
import { type Viewer, viewerFromAuthenticatedClaims } from "../../search.js";

// Same principal every seeded document is ingested under, so seedDoc() and
// testViewer() are always talking about the same identity.
const PRINCIPAL = "test-viewer";

/** Open a fresh, fully-migrated PGlite database — one tmp dir per call, so a
 *  `beforeEach(openTestDb)` gives every test its own isolated catalog. */
export async function openTestDb(): Promise<Db> {
  const dir = mkdtempSync(join(tmpdir(), "eil-window-vectors-"));
  process.env.EIL_DATABASE_URL = `pglite://${dir}`;
  const db = await connect();
  await migrate(db);
  return db;
}

/** The Viewer every seedDoc() document is readable to. Built through the same
 *  trusted-claims path production code requires — a caller-constructed
 *  object would fail isTrustedViewer() and every ACL-gated read. */
export function testViewer(): Viewer {
  return viewerFromAuthenticatedClaims({ principal: PRINCIPAL, tenant: "default", groups: [] });
}

/** Insert one document (tenant 'default', source 'confluence', quality_tier
 *  'authored', owned by testViewer()'s principal) and its single chunk at
 *  seq 0 — the minimum backfill() needs to have something to embed. */
export async function seedDoc(
  db: Db,
  opts: { id: string; text: string; headingPath: string },
): Promise<void> {
  const doc = {
    title: opts.id,
    url: null,
    hierarchy: [],
    aclGroups: [],
    qualityTier: "authored" as const,
    updatedAt: null,
    body: opts.text,
  };
  await db.query(
    "INSERT INTO documents (id, tenant, source, title, quality_tier, content_hash, body, ingested_by)" +
      " VALUES ($1, 'default', 'confluence', $2, 'authored', $3, $4, $5)",
    [opts.id, opts.id, contentHash(doc), opts.text, testViewer().principal],
  );
  await db.query(
    "INSERT INTO chunks (tenant, doc_id, seq, heading_path, text, content_hash)" +
      " VALUES ('default', $1, 0, $2, $3, $4)",
    [opts.id, opts.headingPath, opts.text, chunkHash({ text: opts.text })],
  );
}

/** Deterministic 8-dim embedder with a 100-char window, so windowing is forced
 *  in tests without loading the real 384-dim model.
 *
 *  The brief's reference snippet types embed() as Promise<number[][]>, but
 *  Embedder (ts/embed/index.ts) declares Promise<Float32Array[]> — copying
 *  the number[][] shape verbatim fails `pnpm typecheck`. Same deterministic
 *  math, wrapped in Float32Array so this actually satisfies the interface. */
export const narrowEmbedder: Embedder = {
  id: "test:narrow",
  windowChars: 100,
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Array(8).fill(0);
      for (let i = 0; i < t.length; i++) v[i % 8]! += t.charCodeAt(i) / 1000;
      const n = Math.hypot(...v) || 1;
      return Float32Array.from(v.map((x) => x / n));
    });
  },
};
