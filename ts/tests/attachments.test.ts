/**
 * Attachment acquisition: hostile links, listing completeness, and retirement.
 *
 * The organising idea under test is that three different things look like "no
 * attachment" and only one of them authorises deleting anything:
 *
 *   listed none                 -> retire
 *   listed, but we cannot use it -> keep, and take debt
 *   could not read the listing   -> retire nothing
 *
 * Most cases below exist to prove those stay apart.
 */
import { describe, expect, it } from "vitest";
import { artifactsForDoc, publishArtifactVersion } from "../artifacts.js";
import { type Db, withTransaction } from "../db.js";
import {
  type AttachmentListing,
  acquireAttachments,
  checkedText,
  listConfluenceAttachments,
  listJiraAttachments,
  persistAttachments,
  safeDownloadPath,
  sameOriginPath,
} from "../ingest/attachments.js";
import { normalize as normalizeConfluence } from "../ingest/confluence.js";
import { upsertDocument } from "../store.js";
import { openTestDb } from "./helpers/db.js";

const NUL = "\u0000";
const DEL = "\u007f";
const CRLF = "\r\n";
const BS = "\\";
const JIRA = "https://jira.corp";
const CTX = "https://corp.example/jira";

describe("a download link is untrusted input", () => {
  it("keeps a plain same-origin path, query included", () => {
    expect(safeDownloadPath("/download/attachments/1/a.pdf")).toBe("/download/attachments/1/a.pdf");
    expect(safeDownloadPath("/download/x?version=2")).toBe("/download/x?version=2");
  });

  it("refuses every link that names an origin of its own choosing", () => {
    expect(safeDownloadPath("https://evil.example/x")).toBeNull();
    expect(safeDownloadPath("http://evil.example/x")).toBeNull();
    expect(safeDownloadPath("//evil.example/x")).toBeNull();
    expect(safeDownloadPath("javascript:alert(1)")).toBeNull();
    expect(safeDownloadPath("data:text/plain,x")).toBeNull();
  });

  it("refuses a backslash authority, which no prefix check would catch", () => {
    // `/BSevil.example/x` starts with a single `/`, has no scheme and is not
    // protocol-relative, so every string-prefix guard passes it — but the URL
    // parser treats the backslash as a separator and it resolves to
    // https://evil.example. Only re-reading the ORIGIN after normalisation
    // catches this.
    expect(safeDownloadPath(`/${BS}evil.example/x`)).toBeNull();
    expect(safeDownloadPath(`${BS}${BS}evil.example/x`)).toBeNull();
  });

  it("refuses relative links, which would resolve against whatever came before", () => {
    expect(safeDownloadPath("download/x")).toBeNull();
    expect(safeDownloadPath("../download/x")).toBeNull();
    expect(safeDownloadPath("")).toBeNull();
    expect(safeDownloadPath(null)).toBeNull();
    expect(safeDownloadPath(undefined)).toBeNull();
  });

  it("refuses control characters, which split headers and paths downstream", () => {
    expect(safeDownloadPath(`/download/${NUL}x`)).toBeNull();
    expect(safeDownloadPath(`/download/x${CRLF}X-Injected: 1`)).toBeNull();
    expect(safeDownloadPath(`/download/${DEL}`)).toBeNull();
  });

  it("collapses traversal instead of following it, and stays on our origin", () => {
    // `..` cannot escape an origin — only walk to another path on the same host,
    // which the credential already reaches. The guarantee is ORIGIN safety, not
    // path-prefix confinement, and the assertion says exactly that.
    expect(safeDownloadPath("/download/../../etc/passwd")).toBe("/etc/passwd");
    expect(safeDownloadPath("/download/%2e%2e%2fadmin")).toBe("/download/%2e%2e%2fadmin");
  });

  it("strips the configured context path instead of doubling it", () => {
    // Jira DC is normally deployed under a context path, and every download
    // path in this connector is relative to `baseUrl` because `getBytes` builds
    // `new URL(baseUrl + path)`. Returning the whole pathname produced
    // `https://corp.example/jira/jira/secure/...` — a 404 on every attachment
    // of every context-path deployment, which an origin-only fixture cannot see.
    expect(sameOriginPath(`${CTX}/secure/attachment/10/a.pdf`, CTX)).toBe(
      "/secure/attachment/10/a.pdf",
    );
    // A trailing slash on the configured base must not change the answer.
    expect(sameOriginPath(`${CTX}/secure/x`, `${CTX}/`)).toBe("/secure/x");
    // A root base strips nothing.
    expect(sameOriginPath(`${JIRA}/secure/x`, JIRA)).toBe("/secure/x");
  });

  it("refuses a same-origin URL that sits outside the configured context", () => {
    // Same host, wrong application. Rewriting it into a context-relative path
    // would turn an attacker-controlled field into a credentialed request
    // against something the connector was never pointed at.
    expect(sameOriginPath("https://corp.example/secure/attachment/10/a.pdf", CTX)).toBeNull();
    expect(sameOriginPath("https://corp.example/confluence/download/x", CTX)).toBeNull();
  });

  it("requires a segment boundary, so /jira does not swallow /jiraevil", () => {
    // A bare prefix test accepts this. `/jiraevil` is a different application.
    expect(sameOriginPath("https://corp.example/jiraevil/secure/x", CTX)).toBeNull();
    expect(sameOriginPath("https://corp.example/jira-staging/secure/x", CTX)).toBeNull();
  });

  it("compares a Jira absolute URL's origin instead of keeping only its path", () => {
    // Discarding the origin and keeping the path would turn an attacker-chosen
    // field into a request of their choosing against the REAL Jira, with a real
    // credential. The origin has to match, not merely be dropped.
    expect(sameOriginPath(`${JIRA}/secure/attachment/10/a.pdf`, JIRA)).toBe(
      "/secure/attachment/10/a.pdf",
    );
    expect(sameOriginPath("https://evil.example/secure/attachment/10/a.pdf", JIRA)).toBeNull();
    expect(sameOriginPath(`${JIRA}:8443/secure/x`, JIRA)).toBeNull();
    expect(sameOriginPath("http://jira.corp/secure/x", JIRA)).toBeNull();
    expect(sameOriginPath(null, JIRA)).toBeNull();
  });
});

describe("metadata fails closed rather than being rewritten", () => {
  it("accepts clean values and treats absence as absence", () => {
    expect(checkedText("  report.pdf  ", 255)).toBe("report.pdf");
    expect(checkedText(undefined, 255)).toBeNull();
    expect(checkedText(null, 255)).toBeNull();
    expect(checkedText("   ", 255)).toBeNull();
  });

  it("refuses rather than truncates an over-long value", () => {
    // Truncation invents a value the source never had and records it as though
    // it did. A 300-character filename is refused, not shortened to 255.
    expect(checkedText("a".repeat(300), 255)).not.toBe("a".repeat(255));
    expect(typeof checkedText("a".repeat(300), 255)).toBe("symbol");
  });

  it("refuses rather than strips a control character", () => {
    expect(typeof checkedText(`re${NUL}port.pdf`, 255)).toBe("symbol");
    expect(typeof checkedText(`a${CRLF}b`, 255)).toBe("symbol");
    expect(typeof checkedText(42, 255)).toBe("symbol");
  });
});

const cPage = (entries: any[], extra: Record<string, unknown> = {}) => ({
  results: entries,
  ...extra,
});
const cEntry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `${id}.pdf`,
  version: { number: 1 },
  metadata: { mediaType: "application/pdf" },
  _links: { download: `/download/attachments/${id}` },
  ...over,
});

describe("listed identity is tracked apart from what we can fetch", () => {
  it("keeps a valid id whose download link is off-origin, and takes debt", async () => {
    // The blocker: the id is still on the page. Dropping it from
    // `listedNativeIds` because we refused its LINK would let reconcile retire
    // every stored revision of a live attachment.
    const listing = await listConfluenceAttachments({} as never, "P1", async () =>
      cPage([
        cEntry("good"),
        cEntry("offsite", { _links: { download: "https://evil.example/x" } }),
      ]),
    );
    expect(listing.refs.map((r) => r.nativeId)).toEqual(["good"]);
    expect(listing.listedNativeIds.sort()).toEqual(["good", "offsite"]);
    expect(listing.debt).toBe(1);
    expect(listing.complete).toBe(true);
  });

  it("keeps a valid id whose metadata is unusable, and takes debt", async () => {
    const listing = await listConfluenceAttachments({} as never, "P1", async () =>
      cPage([
        cEntry("badmedia", { metadata: { mediaType: `application/${NUL}pdf` } }),
        cEntry("badname", { title: "x".repeat(400) }),
        cEntry("badrev", { version: { number: "1;drop" } }),
      ]),
    );
    expect(listing.refs).toHaveLength(0);
    expect(listing.listedNativeIds.sort()).toEqual(["badmedia", "badname", "badrev"]);
    expect(listing.debt).toBe(3);
    expect(listing.complete).toBe(true);
  });

  it("downgrades completeness when an id itself cannot be trusted", async () => {
    // An unusable ID is different from an unusable link: we do not know WHICH
    // attachment it was, so it can neither be fetched nor vouch for anything.
    // Retirement must not run against a listing with a hole in it.
    const listing = await listConfluenceAttachments({} as never, "P1", async () =>
      cPage([cEntry("good"), cEntry(`bad${NUL}id`), { title: "no id at all" }]),
    );
    expect(listing.listedNativeIds).toEqual(["good"]);
    expect(listing.debt).toBe(2);
    expect(listing.complete).toBe(false);
  });
});

describe("pagination completeness is taken from the server, not inferred", () => {
  it("follows the next link and reports the whole set as complete", async () => {
    const pages = [
      cPage([cEntry("a0")], { _links: { next: "/rest/api/next" }, size: 1, limit: 50 }),
      cPage([cEntry("b0")], { size: 1, limit: 50 }),
    ];
    let calls = 0;
    const listing = await listConfluenceAttachments({} as never, "P1", async () => pages[calls++]);
    expect(calls).toBe(2);
    expect(listing.listedNativeIds).toEqual(["a0", "b0"]);
    expect(listing.complete).toBe(true);
  });

  it("reports an empty listing as complete — there really are none", async () => {
    const listing = await listConfluenceAttachments({} as never, "P1", async () =>
      cPage([], { size: 0, limit: 50 }),
    );
    expect(listing.listedNativeIds).toHaveLength(0);
    expect(listing.complete).toBe(true);
  });

  it("refuses to call a server-capped full page complete", async () => {
    // We asked for 50; the server capped `limit` at 25 and returned 25 with no
    // `next`. Inferring completeness from `results.length < requestedLimit`
    // declares this exhaustive and retires everything past the cap.
    const listing = await listConfluenceAttachments({} as never, "P1", async () =>
      cPage(
        Array.from({ length: 25 }, (_, i) => cEntry(`x${i}`)),
        { size: 25, limit: 25 },
      ),
    );
    expect(listing.listedNativeIds).toHaveLength(25);
    expect(listing.complete).toBe(false);
  });

  it("stops instead of looping when a page advertises more but delivers none", async () => {
    let calls = 0;
    const listing = await listConfluenceAttachments({} as never, "P1", async () => {
      calls++;
      return cPage([], { _links: { next: "/rest/api/next" } });
    });
    expect(calls).toBe(1);
    expect(listing.complete).toBe(false);
  });

  it("reports a listing truncated by the page bound as INCOMPLETE", async () => {
    let calls = 0;
    const listing = await listConfluenceAttachments(
      {} as never,
      "P1",
      async () => {
        calls++;
        return cPage([cEntry(`x${calls}`)], { _links: { next: "/n" }, size: 1, limit: 50 });
      },
      3,
    );
    expect(calls).toBe(3);
    expect(listing.complete).toBe(false);
  });
});

describe("Jira attachments must be requested before their absence means anything", () => {
  it("treats a missing attachment field as NOT REQUESTED, so nothing may retire", () => {
    // The live field list omitted `attachment`, so every issue looked like it
    // had none — and a complete-and-empty listing authorises retiring all of
    // them. Absence of the field is now incompleteness, not emptiness.
    const listing = listJiraAttachments({ summary: "x" }, JIRA);
    expect(listing.listedNativeIds).toHaveLength(0);
    expect(listing.complete).toBe(false);
  });

  it("treats a requested-and-empty field as genuinely empty", () => {
    const listing = listJiraAttachments({ attachment: [] }, JIRA);
    expect(listing.complete).toBe(true);
  });

  it("keeps a cross-origin attachment listed while refusing its URL", () => {
    const listing = listJiraAttachments(
      {
        attachment: [
          {
            id: "10",
            filename: "a.pdf",
            mimeType: "application/pdf",
            content: `${JIRA}/secure/attachment/10/a.pdf`,
          },
          {
            id: "11",
            filename: "b.pdf",
            mimeType: "application/pdf",
            content: "https://evil.example/secure/attachment/11/b.pdf",
          },
        ],
      },
      JIRA,
    );
    expect(listing.refs.map((r) => r.downloadPath)).toEqual(["/secure/attachment/10/a.pdf"]);
    expect(listing.listedNativeIds).toEqual(["10", "11"]);
    expect(listing.debt).toBe(1);
    expect(listing.complete).toBe(true);
  });
});

describe("acquisition separates refusal from deletion", () => {
  const ref = (id: string) => ({
    nativeId: id,
    revision: "1",
    mediaType: "application/pdf",
    filename: `${id}.pdf`,
    downloadPath: `/download/${id}`,
  });

  it("records every listed id, including ones whose bytes never arrived", async () => {
    const listing: AttachmentListing = {
      refs: [ref("ok"), ref("boom")],
      listedNativeIds: ["ok", "boom"],
      debt: 0,
      complete: true,
    };
    const client = {
      baseUrl: "https://conf.corp",
      headers: {},
      fetcher: async (url: URL) =>
        url.pathname.endsWith("/boom")
          ? new Response("gone", { status: 404 })
          : new Response(Buffer.from("%PDF-1.7 ok"), { status: 200 }),
    };
    const out = await acquireAttachments(client as never, listing);
    expect(out.acquired.map((a) => a.ref.nativeId)).toEqual(["ok"]);
    expect(out.debt).toBe(1);
    expect(out.listedNativeIds.sort()).toEqual(["boom", "ok"]);
    expect(out.listingComplete).toBe(true);
  });

  it("fetches a context-path attachment exactly once, at its original URL", async () => {
    // The end-to-end form of the context-path fix. Asserting on the URL that
    // actually reaches the transport is the only way to catch doubling: the
    // listing looks correct either way, and only the wire shows the 404.
    const listing = listJiraAttachments(
      {
        attachment: [
          {
            id: "10",
            filename: "a.pdf",
            mimeType: "application/pdf",
            content: `${CTX}/secure/attachment/10/a.pdf`,
          },
        ],
      },
      CTX,
    );
    const seen: string[] = [];
    const client = {
      baseUrl: CTX,
      headers: {},
      fetcher: async (url: URL) => {
        seen.push(url.toString());
        return new Response(Buffer.from("%PDF ok"), { status: 200 });
      },
    };
    const out = await acquireAttachments(client as never, listing);
    expect(seen).toEqual([`${CTX}/secure/attachment/10/a.pdf`]);
    expect(out.acquired).toHaveLength(1);
    expect(out.debt).toBe(0);
  });

  it("carries listing debt through, not just download debt", async () => {
    const listing: AttachmentListing = {
      refs: [],
      listedNativeIds: ["offsite"],
      debt: 1,
      complete: true,
    };
    const out = await acquireAttachments(
      { baseUrl: "https://c", headers: {}, fetcher: async () => new Response("") } as never,
      listing,
    );
    expect(out.debt).toBe(1);
  });

  it("captures the ceiling it fetched under so persistence cannot re-read a different one", async () => {
    const prev = process.env.EIL_ARTIFACT_MAX_BYTES;
    process.env.EIL_ARTIFACT_MAX_BYTES = "1000000";
    const out = await acquireAttachments(
      { baseUrl: "https://c", headers: {}, fetcher: async () => new Response("") } as never,
      { refs: [], listedNativeIds: [], debt: 0, complete: true },
    );
    expect(out.maxBytes).toBe(1000000);
    // The environment moves between acquisition and persistence. The captured
    // value must not.
    process.env.EIL_ARTIFACT_MAX_BYTES = "10";
    expect(out.maxBytes).toBe(1000000);
    if (prev === undefined) delete process.env.EIL_ARTIFACT_MAX_BYTES;
    else process.env.EIL_ARTIFACT_MAX_BYTES = prev;
  });
});

describe("retirement keys on the listing, never on what was downloaded", () => {
  let db: Db;
  const TENANT = "default";
  const DOC = "confluence:page:P1";

  const seed = async () => {
    db = await openTestDb();
    await upsertDocument(
      db,
      normalizeConfluence({
        id: "P1",
        title: "Page P1",
        url: null,
        author: null,
        updated: "2026-03-01T00:00:00Z",
        created: "2026-03-01T00:00:00Z",
        ancestors: ["ENG"],
        acl_groups: ["eng"],
        labels: [],
        body: "<p>body</p>",
      } as never),
    );
  };

  const store = (nativeId: string, revision: string, bytes: string) =>
    withTransaction(db, (tx) =>
      publishArtifactVersion(tx, {
        tenant: TENANT,
        source: "confluence",
        nativeId,
        revision,
        docId: DOC,
        mediaType: "application/pdf",
        filename: `${nativeId}.pdf`,
        bytes: Buffer.from(bytes),
      }),
    );

  const persist = (acquisition: Parameters<typeof persistAttachments>[1]["acquisition"]) =>
    withTransaction(db, (tx) =>
      persistAttachments(tx, { tenant: TENANT, source: "confluence", docId: DOC, acquisition }),
    );

  const acq = (over: Partial<Parameters<typeof persistAttachments>[1]["acquisition"]>) => ({
    acquired: [],
    debt: 0,
    listingComplete: true,
    listedNativeIds: [],
    maxBytes: 25 * 1024 * 1024,
    ...over,
  });

  const held = async () =>
    (await artifactsForDoc(db, TENANT, DOC)).map((v) => `${v.nativeId}@${v.revision}`).sort();

  it("KEEPS every stored revision of an id that is listed but failed to download", async () => {
    // `att1` is still on the page — the source listed it — but this run could
    // not fetch its bytes. That is a transport failure, not a deletion.
    //
    // Mutation check: build `present` from `acquisition.acquired` instead of
    // `listedNativeIds` and this fails, because att1 then looks absent.
    await seed();
    await store("att1", "1", "%PDF old revision");
    await store("att1", "2", "%PDF current revision");
    await persist(acq({ debt: 1, listedNativeIds: ["att1"] }));
    expect(await held()).toEqual(["att1@1", "att1@2"]);
    await db.end();
  });

  it("KEEPS a stored artifact whose link has since gone off-origin", async () => {
    // The end-to-end version of the identity/usability split: the page still
    // lists `att1`, but its download URL now points somewhere we refuse to
    // follow. Deriving presence from fetchable refs retires real evidence
    // because an upstream link changed.
    await seed();
    await store("att1", "1", "%PDF stored earlier");
    const listing = await listConfluenceAttachments({} as never, "P1", async () =>
      cPage([cEntry("att1", { _links: { download: "https://evil.example/att1" } })], {
        size: 1,
        limit: 50,
      }),
    );
    expect(listing.refs).toHaveLength(0);
    expect(listing.listedNativeIds).toEqual(["att1"]);
    await persist(
      acq({
        debt: listing.debt,
        listedNativeIds: listing.listedNativeIds,
        listingComplete: listing.complete,
      }),
    );
    expect(await held()).toEqual(["att1@1"]);
    await db.end();
  });

  it("KEEPS stored revisions when a Jira URL points outside the configured context", async () => {
    // Same shape as the off-origin case, one level subtler: the URL is on our
    // own host, just not our application. It is refused, the id stays listed,
    // and the evidence survives.
    await seed();
    await store("10", "1", "%PDF stored earlier");
    const listing = listJiraAttachments(
      {
        attachment: [
          {
            id: "10",
            filename: "a.pdf",
            mimeType: "application/pdf",
            content: "https://corp.example/secure/attachment/10/a.pdf",
          },
        ],
      },
      "https://corp.example/jira",
    );
    expect(listing.refs).toHaveLength(0);
    expect(listing.listedNativeIds).toEqual(["10"]);
    expect(listing.debt).toBe(1);
    expect(listing.complete).toBe(true);

    await persist(
      acq({
        debt: listing.debt,
        listedNativeIds: listing.listedNativeIds,
        listingComplete: listing.complete,
      }),
    );
    expect(await held()).toEqual(["10@1"]);
    await db.end();
  });

  it("retires an id the source genuinely stopped listing, all revisions", async () => {
    await seed();
    await store("stays", "1", "%PDF stays");
    await store("gone", "1", "%PDF gone v1");
    await store("gone", "2", "%PDF gone v2");
    await persist(acq({ listedNativeIds: ["stays"] }));
    expect(await held()).toEqual(["stays@1"]);
    await db.end();
  });

  it("retires NOTHING when the listing was incomplete", async () => {
    await seed();
    await store("a", "1", "%PDF a");
    await store("b", "1", "%PDF b");
    await persist(acq({ listingComplete: false, listedNativeIds: ["a"] }));
    expect(await held()).toEqual(["a@1", "b@1"]);
    await db.end();
  });

  it("adds a new revision without disturbing the previous one", async () => {
    await seed();
    await store("att1", "1", "%PDF v1");
    await persist(
      acq({
        acquired: [
          {
            ref: {
              nativeId: "att1",
              revision: "2",
              mediaType: "application/pdf",
              filename: "att1.pdf",
              downloadPath: "/download/att1",
            },
            bytes: Buffer.from("%PDF v2"),
          },
        ],
        listedNativeIds: ["att1"],
      }),
    );
    expect(await held()).toEqual(["att1@1", "att1@2"]);
    await db.end();
  });

  it("publishes under the acquired ceiling even after the environment shrinks", async () => {
    // The drift blocker. The bytes were accepted under a 25MB ceiling; if
    // persistence re-read the environment it would now see 10 bytes and throw
    // ArtifactTooLarge INSIDE the parent's transaction, rolling back a page
    // that was perfectly fine.
    await seed();
    const prev = process.env.EIL_ARTIFACT_MAX_BYTES;
    process.env.EIL_ARTIFACT_MAX_BYTES = "10";
    try {
      await persist(
        acq({
          acquired: [
            {
              ref: {
                nativeId: "big",
                revision: "1",
                mediaType: "application/pdf",
                filename: "big.pdf",
                downloadPath: "/download/big",
              },
              bytes: Buffer.from("%PDF larger than ten bytes"),
            },
          ],
          listedNativeIds: ["big"],
        }),
      );
      expect(await held()).toEqual(["big@1"]);
    } finally {
      if (prev === undefined) delete process.env.EIL_ARTIFACT_MAX_BYTES;
      else process.env.EIL_ARTIFACT_MAX_BYTES = prev;
      await db.end();
    }
  });
});
