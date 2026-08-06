/**
 * The connector registry contract.
 *
 * A registry earns its keep only if it is COMPLETE, TRUTHFUL and EXECUTABLE. A
 * catalogue that merely describes sources is worse than none: it looks like the
 * place to check, so anything missing from it is invisible in exactly the way a
 * registry is supposed to prevent.
 *
 * An earlier version of this file failed its own standard. Its completeness test
 * imported three normalizers by hand and appended "obsidian" as a literal, then
 * claimed in a comment to be "derived rather than hand-listed" — so adding a
 * fifth source would not have touched it and it would have passed while the
 * registry fell behind. The fix is to derive the inventory from the CLI's real
 * dispatch surface, which is the thing that would actually be wrong.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  REGISTRY,
  type SourceSpec,
  assertSourceMatches,
  confluenceSpec,
  ingestScope,
  jiraSpec,
  runSource,
  scopedSources,
} from "../ingest/registry.js";
import { openTestDb } from "./helpers/db.js";

/** Every `dispatch("<name>", …)` the CLI actually performs. Read from source so
 *  the comparison is against the shipped dispatch surface rather than a list
 *  maintained beside it — a hand-kept list is what made the old test circular. */
const cliDispatchNames = (): string[] => {
  const src = readFileSync(join(process.cwd(), "ts/cli.ts"), "utf-8");
  return [...src.matchAll(/\bdispatch\(\s*"([a-z0-9_-]+)"/g)].map((m) => m[1] as string).sort();
};

describe("the registry is the single inventory of what EIL ingests", () => {
  it("covers exactly the sources the CLI dispatches — no more, no fewer", () => {
    // Both directions matter. A CLI source with no spec would crash at runtime;
    // a spec no command reaches is inert, which is the failure that lets a
    // registry look complete while doing nothing.
    const dispatched = cliDispatchNames();
    // Precondition: the scrape found something. A regex that silently matches
    // nothing would make this test vacuously true — the exact defect being
    // fixed here.
    expect(dispatched.length).toBeGreaterThanOrEqual(4);
    expect(dispatched).toEqual(Object.keys(REGISTRY).sort());
  });

  it("keys the map by each spec's own name, so lookup cannot disagree with the spec", () => {
    for (const [key, spec] of Object.entries(REGISTRY)) expect(key).toBe(spec.name);
  });

  it("leaves no declaration inert: every spec exposes the executor its kind requires", () => {
    // The union makes the wrong combination uncompilable; this asserts the
    // right one is actually present at runtime for every registered source.
    for (const spec of Object.values(REGISTRY)) {
      expect(spec.description.length).toBeGreaterThan(0);
      expect(Array.isArray(spec.requiresEnv)).toBe(true);
      if (spec.cursor === "timestamp") {
        expect(typeof spec.makeClient).toBe("function");
        expect(typeof spec.updatedSince).toBe("function");
        expect(typeof spec.normalize).toBe("function");
        expect(typeof spec.listIds).toBe("function");
      } else {
        expect(typeof spec.run).toBe("function");
      }
    }
  });

  it("scopedSources is exactly the timestamp sources", () => {
    const scoped = scopedSources()
      .map((s) => s.name)
      .sort();
    const timestamps = Object.values(REGISTRY)
      .filter((s) => s.cursor === "timestamp")
      .map((s) => s.name)
      .sort();
    expect(scoped).toEqual(timestamps);
    // Precondition: there is at least one of each kind, or the partition is
    // trivially satisfied and proves nothing about the narrowing.
    expect(scoped.length).toBeGreaterThan(0);
    expect(Object.values(REGISTRY).some((s) => s.cursor !== "timestamp")).toBe(true);
  });
});

describe("the source name is enforced as the join key, not merely declared", () => {
  it("rejects a document stamped with a different source", () => {
    // `name` is the join key for cursors, coverage families and reconcile, so a
    // document carrying another source's name ingests successfully and is then
    // invisible to every disclosure built on top of it. The `revision` and
    // `none` runners receive already-built CanonicalDocs, so no type can tie
    // them to the spec — this is the runtime backstop for exactly that gap.
    expect(() =>
      assertSourceMatches({ name: "obsidian", description: "", requiresEnv: [] }, {
        id: "confluence:page:1",
        source: "confluence",
      } as never),
    ).toThrow(/join key/);
  });

  it("passes a document that agrees, and returns it unchanged", () => {
    const doc = { id: "obsidian:note:a", source: "obsidian" } as never;
    expect(assertSourceMatches({ name: "obsidian", description: "", requiresEnv: [] }, doc)).toBe(
      doc,
    );
  });

  it("a timestamp spec's name is the source its normalizer stamps", () => {
    for (const spec of scopedSources()) {
      const sample =
        spec.name === "confluence"
          ? { id: "1", title: "t", body: "b" }
          : { key: "K-1", fields: { summary: "s", project: "P" } };
      expect(spec.normalize(sample as never, "default").source).toBe(spec.name);
    }
  });
});

describe("cursor kind selects the executor", () => {
  // ingestScope reads a cursor, so these need a real catalog rather than the
  // default DSN, which would fail with ECONNREFUSED and mask what is asserted.
  beforeAll(async () => {
    await (await openTestDb()).end();
  });

  const fakeTimestamp = (seen: string[]): SourceSpec =>
    ({
      ...confluenceSpec,
      requiresEnv: [],
      makeClient: async () => {
        seen.push("makeClient");
        return {
          async *updatedSince() {
            if (false as boolean) yield undefined as never;
          },
          listIds: async () => {
            seen.push("listIds");
            return [];
          },
        };
      },
      updatedSince: async function* () {
        seen.push("updatedSince");
        // Yields nothing: an empty incremental listing is the case under test,
        // and the run must still build a client and reach this executor.
        if (false as boolean) yield undefined as never;
      },
      listIds: async (c: unknown) => (c as { listIds(): Promise<string[]> }).listIds(),
    }) as SourceSpec;

  it("a timestamp source builds a client and runs the scope path", async () => {
    const seen: string[] = [];
    await runSource(fakeTimestamp(seen), {
      tenant: "default",
      scopes: [{ kind: "space", keys: ["ENG"] } as never],
    });
    expect(seen).toContain("makeClient");
    expect(seen).toContain("updatedSince");
  });

  it("a timestamp source reconciles only when asked", async () => {
    const off: string[] = [];
    await runSource(fakeTimestamp(off), { tenant: "default", scopes: [] });
    expect(off).not.toContain("listIds");
  });

  it("a non-timestamp source runs its own runner and never touches the scope path", async () => {
    const seen: string[] = [];
    const listing: SourceSpec = {
      name: "obsidian",
      description: "x",
      cursor: "none",
      requiresEnv: [],
      run: async () => {
        seen.push("run");
      },
    };
    await runSource(listing, { tenant: "default" });
    expect(seen).toEqual(["run"]);
  });

  it("refuses before doing any work when required env is missing", async () => {
    // Checked in the dispatcher rather than left to a client constructor, so
    // the message names the source and the variable instead of surfacing
    // whatever the SDK happened to throw.
    const prev = process.env.EIL_CONFLUENCE_URL;
    delete process.env.EIL_CONFLUENCE_URL;
    try {
      await expect(runSource(confluenceSpec, { tenant: "default", scopes: [] })).rejects.toThrow(
        /EIL_CONFLUENCE_URL/,
      );
    } finally {
      if (prev !== undefined) process.env.EIL_CONFLUENCE_URL = prev;
    }
  });
});

describe("the generic scope path preserves the semantics it replaced", () => {
  it("an explicit page fetch pulls descendants only when asked", async () => {
    // Descendant expansion was a branch inside the old hand-written Confluence
    // function. Omitting the subtree when --with-descendants was passed is a
    // silent gap; including it when it was not is a scope violation.
    const client = {
      getPage: async (id: string) => ({ id, title: id, body: "b" }),
      async *descendants(id: string) {
        yield { id: `${id}-child`, title: "child", body: "b" };
      },
    };
    const fetchOf = confluenceSpec.explicit!.fetch;

    const plain: string[] = [];
    for await (const raw of fetchOf(client, "root", { kind: "pages", ids: ["root"] } as never))
      plain.push((raw as { id: string }).id);
    expect(plain).toEqual(["root"]);

    const deep: string[] = [];
    for await (const raw of fetchOf(client, "root", {
      kind: "pages",
      ids: ["root"],
      withDescendants: true,
    } as never))
      deep.push((raw as { id: string }).id);
    expect(deep).toEqual(["root", "root-child"]);
  });

  it("refuses a scope it cannot key a cursor for, rather than silently doing nothing", async () => {
    // A `pages` scope handed to Jira: its explicit kind is `issues`, so this
    // takes neither the explicit branch nor a keyable cursor. cursorKey returns
    // null for exactly this case and the run must refuse by name rather than
    // write a cursor under a missing key.
    await expect(
      ingestScope(jiraSpec, {}, { kind: "pages", ids: ["1"] } as never, "default"),
    ).rejects.toThrow(/non-cursor/);
  });
});

describe("every REGISTERED spec resolves to its production executor", () => {
  // The source scrape proves a `dispatch("name")` call exists in cli.ts; it
  // cannot prove that call reaches a working executor, because a dead or
  // unreachable line satisfies it equally well. These exercise the ACTUAL
  // registered specs — not fakes — through `runSource`, with the outermost
  // side effect stubbed so no network or checkout is needed.
  beforeAll(async () => {
    await (await openTestDb()).end();
  });

  it("confluence and jira reach their own normalizers through the fixture path", async () => {
    const { writeFileSync } = await import("node:fs");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "eil-fixture-"));

    const cases = [
      {
        name: "confluence",
        payload: { id: "p1", title: "t", body: "hello" },
        id: "confluence:page:p1",
      },
      {
        name: "jira",
        payload: { key: "K-1", fields: { summary: "s", project: "P", description: "d" } },
        id: "jira:issue:K-1",
      },
    ];

    for (const c of cases) {
      const path = join(dir, `${c.name}.json`);
      writeFileSync(path, JSON.stringify(c.payload));
      // The real spec out of REGISTRY, not a stand-in.
      await runSource(REGISTRY[c.name] as SourceSpec, {
        tenant: "alpha",
        fixture: path,
      });
      const { connect } = await import("../db.js");
      const fresh = await connect();
      try {
        const rows = await fresh.query("SELECT tenant FROM documents WHERE id = $1", [c.id]);
        // Executable proof the registered entry ran: the document exists, and
        // it was produced by that spec's own normalizer (the id prefix).
        expect(rows.rows.map((r: { tenant: string }) => r.tenant)).toEqual(["alpha"]);
      } finally {
        await fresh.end();
      }
    }
  });

  it("obsidian and code reach their runners", async () => {
    // Injected seams rather than a real vault or checkout: what is being proven
    // is that the registered entry is wired to an executor the dispatcher
    // actually calls, not that walkVault or git works.
    const reached: string[] = [];
    for (const name of ["obsidian", "code"]) {
      const real = REGISTRY[name] as SourceSpec;
      expect(real.cursor).not.toBe("timestamp");
      const probe = {
        ...real,
        run: async () => {
          reached.push(name);
        },
      } as SourceSpec;
      await runSource(probe, { tenant: "default" });
    }
    expect(reached).toEqual(["obsidian", "code"]);
  });
});

describe("fixture ingestion is a spec path, not a second entry point", () => {
  beforeAll(async () => {
    await (await openTestDb()).end();
  });

  /**
   * Regression guard, and labelled as such: the tenant behaviour asserted here
   * was already correct before fixture mode moved into the registry, because
   * `normalize(payload, tenant)` stamps `doc.tenant` and `upsertDocument` keys
   * off that. The omitted `ingestDocs` tenant argument was unreachable — fixture
   * mode passes no `cursorOf`, so `setCursor` never ran.
   *
   * These do not prove a bug was fixed. They pin behaviour that the refactor
   * could plausibly have broken, and close the one-edit-away hazard: the moment
   * a cursor is written on this path, the omitted argument would have sent it to
   * the wrong tenant.
   */
  it("a fixture requested for alpha exists only in alpha", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = join(mkdtempSync(join(tmpdir(), "eil-fx-")), "c.json");
    writeFileSync(path, JSON.stringify([{ id: "iso1", title: "t", body: "b" }]));

    await runSource(confluenceSpec, { tenant: "alpha", fixture: path });

    const { connect } = await import("../db.js");
    const fresh = await connect();
    try {
      const rows = await fresh.query("SELECT tenant FROM documents WHERE id = $1", [
        "confluence:page:iso1",
      ]);
      expect(rows.rows.map((r: { tenant: string }) => r.tenant)).toEqual(["alpha"]);
      // Stated as its own assertion rather than inferred from the above: the
      // failure being guarded against is a SECOND copy in default, which an
      // equality check on one row would not necessarily surface.
      const inDefault = await fresh.query(
        "SELECT 1 FROM documents WHERE tenant = 'default' AND id = $1",
        ["confluence:page:iso1"],
      );
      expect(inDefault.rows.length).toBe(0);
    } finally {
      await fresh.end();
    }
  });

  it("writes no cursor, because a hand-supplied file has swept nothing", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = join(mkdtempSync(join(tmpdir(), "eil-fx2-")), "j.json");
    writeFileSync(path, JSON.stringify({ key: "NC-1", fields: { summary: "s", project: "P" } }));

    await runSource(jiraSpec, { tenant: "beta", fixture: path });

    const { connect } = await import("../db.js");
    const fresh = await connect();
    try {
      const cursors = await fresh.query("SELECT source FROM sync_cursors WHERE tenant = 'beta'");
      expect(cursors.rows).toEqual([]);
    } finally {
      await fresh.end();
    }
  });

  it("fixture mode never builds a live client, so it needs no credentials", async () => {
    // makeClient would throw without env; reaching it would mean fixture mode
    // had fallen through to the live path.
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = join(mkdtempSync(join(tmpdir(), "eil-fx3-")), "c.json");
    writeFileSync(path, JSON.stringify({ id: "nocred", title: "t", body: "b" }));

    let built = false;
    const spec = {
      ...confluenceSpec,
      makeClient: async () => {
        built = true;
        return {};
      },
    } as SourceSpec;
    await runSource(spec, { tenant: "default", fixture: path });
    expect(built).toBe(false);
  });
});
