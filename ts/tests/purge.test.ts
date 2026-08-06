/**
 * Retention purge with attachments in the way.
 *
 * The purge used to be one `DELETE FROM documents`. Artifacts changed that: the
 * reference is ON DELETE RESTRICT, so the old statement does not delete less —
 * it ERRORS, and retention silently stops running. These tests pin the error
 * (so nobody "simplifies" the ordering back out), the atomicity, and the two
 * ways the sweep could destroy something it should not: a blob still cited by
 * another document, and anything at all during a dry run.
 */
import { describe, expect, it } from "vitest";
import { artifactsForDoc, publishArtifactVersion, putArtifact, sha256 } from "../artifacts.js";
import { type Db, type TxHost, withTransaction } from "../db.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { PurgeRaced, purgeExpiredQuarantine } from "../purge.js";
import { upsertDocument } from "../store.js";
import { openTestDb } from "./helpers/db.js";

const PDF = Buffer.from("%PDF-1.7 shared bytes");

async function seedDoc(db: Db, id: string, tenant = "default"): Promise<string> {
  const doc = normalizeConfluence({
    id,
    title: `Page ${id}`,
    url: null,
    author: null,
    updated: "2026-03-01T00:00:00Z",
    created: "2026-03-01T00:00:00Z",
    ancestors: ["ENG"],
    acl_groups: ["eng"],
    labels: [],
    body: "<p>body</p>",
  } as never);
  await upsertDocument(db, { ...doc, tenant });
  return `confluence:page:${id}`;
}

/** Move a document past its quarantine window, as the retention clock would. */
const expire = (db: Db, docId: string) =>
  db.query(
    "UPDATE documents SET tombstoned_at = now() - interval '40 days'," +
      " quarantine_until = now() - interval '10 days' WHERE id = $1",
    [docId],
  );

const attach = (db: Db, docId: string, nativeId: string, bytes: Buffer, tenant = "default") =>
  withTransaction(db, (tx) =>
    publishArtifactVersion(tx, {
      tenant,
      source: "confluence",
      nativeId,
      revision: "1",
      docId,
      mediaType: "application/pdf",
      filename: `${nativeId}.pdf`,
      bytes,
    }),
  );

const countRows = async (db: Db, table: string): Promise<number> =>
  Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

/**
 * A database handle whose first query matching `marker` fails.
 *
 * This is the only honest way to assert atomicity: asserting that a purge which
 * SUCCEEDS left consistent state proves nothing about the failure path, and the
 * failure path is where a half-applied purge would destroy evidence.
 */
function failOn(db: Db, marker: string): TxHost {
  let fired = false;
  return {
    query: async (text: string, params?: any[]) => {
      if (!fired && text.includes(marker)) {
        fired = true;
        throw new Error("injected: connection lost mid-purge");
      }
      return db.query(text, params);
    },
    end: () => db.end(),
  };
}

describe("purging a quarantine-expired document takes its evidence with it", () => {
  it("removes the document, its attachment reference and its now-orphaned blob", async () => {
    const db = await openTestDb();
    const doc = await seedDoc(db, "A");
    await attach(db, doc, "att1", PDF);
    await expire(db, doc);

    const out = await purgeExpiredQuarantine(db);
    expect(out).toMatchObject({
      documents: 1,
      artifactVersions: 1,
      artifactBlobs: 1,
      artifactBytes: PDF.length,
      tenants: ["default"],
    });
    expect(await countRows(db, "documents")).toBe(0);
    expect(await countRows(db, "artifact_versions")).toBe(0);
    expect(await countRows(db, "artifacts")).toBe(0);
    await db.end();
  });

  it("is required: the bare DELETE this replaced fails outright", async () => {
    // Pins the reason the helper exists. If this ever stops throwing, the FK
    // was weakened to CASCADE and a routine catalog delete now destroys
    // evidence silently — which is the failure the RESTRICT was chosen to make
    // loud. Either way the helper's ordering needs re-deciding, not deleting.
    const db = await openTestDb();
    const doc = await seedDoc(db, "A");
    await attach(db, doc, "att1", PDF);
    await expire(db, doc);

    await expect(db.query("DELETE FROM documents WHERE tombstoned_at IS NOT NULL")).rejects.toThrow(
      /foreign key/i,
    );
    await db.end();
  });

  it("leaves documents whose quarantine window is still open", async () => {
    const db = await openTestDb();
    const doc = await seedDoc(db, "A");
    await attach(db, doc, "att1", PDF);
    await db.query(
      "UPDATE documents SET tombstoned_at = now(), quarantine_until = now() + interval '10 days'",
    );

    const out = await purgeExpiredQuarantine(db);
    expect(out.documents).toBe(0);
    expect(await countRows(db, "documents")).toBe(1);
    expect(await countRows(db, "artifact_versions")).toBe(1);
    await db.end();
  });

  it("keeps a deduplicated blob that a surviving document still cites", async () => {
    // The same PDF attached to two pages is ONE blob. Purging one page must not
    // take the bytes the other page's citation resolves against.
    const db = await openTestDb();
    const dead = await seedDoc(db, "A");
    const live = await seedDoc(db, "B");
    await attach(db, dead, "att1", PDF);
    await attach(db, live, "att2", PDF);
    expect(await countRows(db, "artifacts")).toBe(1);
    await expire(db, dead);

    const out = await purgeExpiredQuarantine(db);
    expect(out.documents).toBe(1);
    expect(out.artifactVersions).toBe(1);
    // Reference count went 2 -> 1, so the blob is NOT garbage.
    expect(out.artifactBlobs).toBe(0);
    expect(await countRows(db, "artifacts")).toBe(1);
    expect((await artifactsForDoc(db, "default", live)).map((v) => v.nativeId)).toEqual(["att2"]);
    await db.end();
  });

  it("dry run reports the real numbers and changes nothing", async () => {
    const db = await openTestDb();
    const doc = await seedDoc(db, "A");
    await attach(db, doc, "att1", PDF);
    await expire(db, doc);

    const preview = await purgeExpiredQuarantine(db, { dryRun: true });
    expect(preview).toMatchObject({
      documents: 1,
      artifactVersions: 1,
      artifactBlobs: 1,
      artifactBytes: PDF.length,
    });
    // Nothing moved.
    expect(await countRows(db, "documents")).toBe(1);
    expect(await countRows(db, "artifact_versions")).toBe(1);
    expect(await countRows(db, "artifacts")).toBe(1);

    // And the real run agrees with its own preview, which is the whole point of
    // measuring by rolling back a real attempt rather than by predicting one.
    const real = await purgeExpiredQuarantine(db);
    expect(real).toMatchObject(preview);
    expect(await countRows(db, "documents")).toBe(0);
    await db.end();
  });

  it("rolls back completely when the document delete fails mid-purge", async () => {
    // Versions are deleted BEFORE documents. If the second statement dies and
    // the first is not undone, the surviving document has had its evidence
    // destroyed — strictly worse than either endpoint.
    const db = await openTestDb();
    const doc = await seedDoc(db, "A");
    await attach(db, doc, "att1", PDF);
    await expire(db, doc);

    await expect(purgeExpiredQuarantine(failOn(db, "DELETE FROM documents d"))).rejects.toThrow(
      /connection lost mid-purge/,
    );

    expect(await countRows(db, "documents")).toBe(1);
    expect(await countRows(db, "artifact_versions")).toBe(1);
    expect(await countRows(db, "artifacts")).toBe(1);
    await db.end();
  });

  it("leaves an unrelated pre-existing orphan blob alone, and out of its report", async () => {
    // A tenant-wide sweep deleted every orphan in the tenant and then counted
    // them as bytes THIS purge freed. Both halves are wrong: it destroys data
    // the purge was never asked about, and it misattributes it in the report an
    // operator uses to reason about retention.
    const db = await openTestDb();
    const doc = await seedDoc(db, "A");
    await attach(db, doc, "att1", PDF);
    // An orphan with no version referencing it, present before this purge runs.
    const orphan = Buffer.from("%PDF unrelated orphan");
    await withTransaction(db, (tx) => putArtifact(tx, "default", orphan));
    expect(await countRows(db, "artifacts")).toBe(2);
    await expire(db, doc);

    const out = await purgeExpiredQuarantine(db);
    expect(out.artifactBlobs).toBe(1);
    expect(out.artifactBytes).toBe(PDF.length);
    // The orphan is still there. It may be garbage, but it is not this
    // command's garbage.
    const left = await db.query("SELECT digest FROM artifacts");
    expect(left.rows).toHaveLength(1);
    expect(left.rows[0].digest).toBe(sha256(orphan));
    await db.end();
  });

  it("aborts rather than completing when a locked document is restored underneath it", async () => {
    // The race the row lock exists to prevent, staged by injection because a
    // second concurrent writer cannot be opened against this PGlite handle.
    //
    // Between retiring the attachments and deleting the parent, the tombstone
    // is cleared — a re-ingest restoring the page. The guarded delete then
    // correctly spares the row, and finishing the transaction would leave a
    // LIVE document whose evidence had already been destroyed. Refusing puts
    // the attachments back.
    const db = await openTestDb();
    const doc = await seedDoc(db, "A");
    await attach(db, doc, "att1", PDF);
    await expire(db, doc);

    const restoreBeforeDelete: TxHost = {
      query: async (text: string, params?: any[]) => {
        if (text.includes("DELETE FROM documents d"))
          await db.query("UPDATE documents SET tombstoned_at = NULL, quarantine_until = NULL");
        return db.query(text, params);
      },
      end: () => db.end(),
    };

    await expect(purgeExpiredQuarantine(restoreBeforeDelete)).rejects.toThrow(PurgeRaced);
    expect(await countRows(db, "documents")).toBe(1);
    expect(await countRows(db, "artifact_versions")).toBe(1);
    expect(await countRows(db, "artifacts")).toBe(1);
    await db.end();
  });

  it("takes a row lock on its candidates", async () => {
    // Structural, and deliberately labelled as such. A genuinely concurrent
    // writer cannot be staged against a single PGlite handle, so the behavioural
    // guarantee is carried by the abort test above; this pins that the lock is
    // actually requested, since dropping it is otherwise invisible until
    // production has two workers.
    const db = await openTestDb();
    const seen: string[] = [];
    const recorder: TxHost = {
      query: async (text: string, params?: any[]) => {
        seen.push(text);
        return db.query(text, params);
      },
      end: () => db.end(),
    };
    await purgeExpiredQuarantine(recorder);
    expect(seen.some((q) => /SELECT tenant, id FROM documents[\s\S]*FOR UPDATE/.test(q))).toBe(
      true,
    );
    await db.end();
  });

  it("does not reach across tenants when ids collide", async () => {
    const db = await openTestDb();
    const doc = await seedDoc(db, "A");
    await attach(db, doc, "att1", PDF);
    // Same document id, different tenant, NOT expired, WITH its own attachment.
    // The attachment is the point: the document delete re-checks the expiry
    // predicate and would spare the other tenant's row anyway, but the version
    // delete has no such guard — matching on id alone destroys the other
    // tenant's evidence while its document survives, citing bytes that are gone.
    await seedDoc(db, "A", "other");
    await attach(db, doc, "att-other", Buffer.from("%PDF other tenant"), "other");
    await db.query(
      "UPDATE documents SET tombstoned_at = now() - interval '40 days'," +
        " quarantine_until = now() - interval '10 days' WHERE tenant = 'default'",
    );

    const out = await purgeExpiredQuarantine(db);
    expect(out.tenants).toEqual(["default"]);
    expect(out.artifactVersions).toBe(1);
    const survivors = await db.query("SELECT tenant FROM documents");
    expect(survivors.rows.map((r: { tenant: string }) => r.tenant)).toEqual(["other"]);
    expect((await artifactsForDoc(db, "other", doc)).map((v) => v.nativeId)).toEqual(["att-other"]);
    expect(await countRows(db, "artifacts")).toBe(1);
    await db.end();
  });
});
