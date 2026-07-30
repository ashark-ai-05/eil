import { describe, expect, it } from "vitest";
import { type CheckContext, allChecks, analyse } from "../reqs/analyse.js";
import type { Finding } from "../reqs/schema.js";
import { clone, minimalBody } from "./helpers/reqs-fixture.js";

const ids = async (b: unknown) => (await analyse(b as any)).findings.map((f) => f.id);

describe("analyse — clean body", () => {
  it("passes the minimal body with no errors", async () => {
    const r = await analyse(clone(minimalBody()));
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("reports how many checks ran", async () => {
    expect((await analyse(clone(minimalBody()))).checksRun).toBeGreaterThan(15);
  });
});

describe("SCORE-001 — the model's arithmetic is never trusted", () => {
  it("refuses a stored magnitude that disagrees with the recompute", async () => {
    const b = clone(minimalBody());
    (b.tree as any).score.magnitude = 21;
    expect(await ids(b)).toContain("SCORE-001");
    expect((await analyse(b)).ok).toBe(false);
  });
});

describe("TREE-001 — inadmissible decisions", () => {
  it("refuses a leaf at or above the decompose threshold", async () => {
    const b = clone(minimalBody());
    (b.tree as any).score = {
      unknowns: 8,
      complexity: 8,
      magnitude: 8,
      decision: "leaf",
      at: "2026-07-30T00:00:00.000Z",
    };
    (b.tree as any).scoreHistory = [b.tree.score];
    expect(await ids(b)).toContain("TREE-001");
  });
});

describe("TREE-002", () => {
  it("refuses a decompose with a single child", async () => {
    const b = clone(minimalBody());
    const at = "2026-07-30T00:00:00.000Z";
    (b.tree as any).score = { unknowns: 8, complexity: 8, magnitude: 8, decision: "decompose", at };
    (b.tree as any).scoreHistory = [b.tree.score];
    (b.tree as any).decision = "decompose";
    (b.tree as any).isLeaf = false;
    delete (b.tree as any).acceptanceCriteria;
    (b.tree as any).children = [
      { ...clone(minimalBody().tree), id: "REQ-ROOT.1", parentId: "REQ-ROOT", nodeKey: "a.b" },
    ];
    expect(await ids(b)).toContain("TREE-002");
  });
});

describe("SCORE-006 — a clarification must actually reduce uncertainty", () => {
  it("refuses clarify -> leaf where the unknowns did not fall", async () => {
    const b = clone(minimalBody());
    const at = "2026-07-30T00:00:00.000Z";
    (b.tree as any).scoreHistory = [
      { unknowns: 8, complexity: 2, magnitude: 8, decision: "clarify", at },
      {
        unknowns: 8,
        complexity: 2,
        magnitude: 8,
        decision: "leaf",
        at: "2026-07-30T01:00:00.000Z",
      },
    ];
    (b.tree as any).score = b.tree.scoreHistory[1];
    expect(await ids(b)).toContain("SCORE-006");
  });
});

describe("UNCERT-001 — the review zone needs an accepted residual", () => {
  it("refuses a review-zone leaf with no residual reference", async () => {
    const b = clone(minimalBody());
    const at = "2026-07-30T00:00:00.000Z";
    (b.tree as any).score = { unknowns: 3, complexity: 3, magnitude: 3, decision: "leaf", at };
    (b.tree as any).scoreHistory = [b.tree.score];
    expect(await ids(b)).toContain("UNCERT-001");
  });
});

describe("TREE-006 — the pre-drawn-tree signature is advisory, not fatal", () => {
  it("warns on uniform depth without blocking", async () => {
    const b = clone(minimalBody());
    const at = "2026-07-30T00:00:00.000Z";
    (b.tree as any).score = { unknowns: 8, complexity: 8, magnitude: 8, decision: "decompose", at };
    (b.tree as any).scoreHistory = [b.tree.score];
    (b.tree as any).decision = "decompose";
    (b.tree as any).isLeaf = false;
    delete (b.tree as any).acceptanceCriteria;
    (b.tree as any).children = [1, 2].map((n) => ({
      ...clone(minimalBody().tree),
      id: `REQ-ROOT.${n}`,
      parentId: "REQ-ROOT",
      nodeKey: `child.${n}`,
      acceptanceCriteria: [
        {
          id: `AC-${n}`,
          stakeholder: "QA",
          given: "g",
          when: "w",
          // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
          then: ["rejects with code 4001"],
          observable: true,
        },
      ],
    }));
    // The ACs moved off the root onto the two new leaves, so the index minimalBody
    // came with now points at the wrong node. Task 6 had no TRACE-001 to notice;
    // task 7 does, and this test is about TREE-006, not about a stale index.
    b.traceability = { "AC-1": "REQ-ROOT.1", "AC-2": "REQ-ROOT.2" };
    const r = await analyse(b as any);
    expect(r.findings.find((f) => f.id === "TREE-006")?.severity).toBe("warning");
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Beyond the brief: every one of the 19 checks is proved to FIRE on a minimal
// violating body and to stay SILENT on the clean one. A check that never fires
// is worse than no check, because it looks like coverage.
// ---------------------------------------------------------------------------

const AT = "2026-07-30T00:00:00.000Z";
const LATER = "2026-07-30T01:00:00.000Z";

const TASK_6_CHECKS = [
  "SCHEMA-001",
  "SCHEMA-002",
  "SCHEMA-003",
  "SCHEMA-004",
  "SCHEMA-005",
  "TREE-001",
  "TREE-002",
  "TREE-003",
  "TREE-004",
  "TREE-005",
  "TREE-006",
  "SCORE-001",
  "SCORE-002",
  "SCORE-003",
  "SCORE-005",
  "SCORE-006",
  "UNCERT-001",
  "UNCERT-002",
  "UNCERT-005",
];

/**
 * Runs one check in isolation over a body that may be deliberately invalid.
 * The schema is strict about a few of the fields these checks guard, so the
 * only way to exercise those checks is to hand them an unvalidated body —
 * which is exactly the situation they exist to survive.
 */
const fire = async (id: string, body: unknown): Promise<Finding[]> => {
  const check = allChecks().find((c) => c.id === id);
  if (!check) throw new Error(`no such check: ${id}`);
  return await check.run({ body, assembled: body } as unknown as CheckContext);
};

let acSeq = 0;

const leafNode = (id: string, parentId: string, key: string): any => {
  acSeq += 1;
  return {
    id,
    parentId,
    nodeKey: key,
    statement: `leaf ${id}`,
    score: { unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at: AT },
    scoreHistory: [{ unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at: AT }],
    decision: "leaf",
    isLeaf: true,
    acceptanceCriteria: [
      {
        id: `AC-${acSeq}`,
        stakeholder: "QA",
        given: "an amendment",
        when: "it is applied",
        // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
        then: ["returns status 200"],
        observable: true,
      },
    ],
    grounding: [],
  };
};

const branchNode = (
  id: string,
  parentId: string | undefined,
  key: string,
  children: any[],
): any => {
  const node: any = {
    id,
    nodeKey: key,
    statement: `branch ${id}`,
    score: { unknowns: 8, complexity: 8, magnitude: 8, decision: "decompose", at: AT },
    scoreHistory: [{ unknowns: 8, complexity: 8, magnitude: 8, decision: "decompose", at: AT }],
    decision: "decompose",
    isLeaf: false,
    children,
    grounding: [],
  };
  if (parentId !== undefined) node.parentId = parentId;
  return node;
};

/**
 * The traceability index these fixtures ought to carry. Task 6 wrote `{}`, which
 * was clean then because nothing checked the index; TRACE-001 and META-002 now
 * do, and an empty index alongside acceptance criteria is a genuine defect the
 * fixtures must not be stating by accident.
 */
const traceOf = (root: any): Record<string, string> => {
  const out: Record<string, string> = {};
  const visit = (n: any) => {
    for (const ac of n.acceptanceCriteria ?? []) out[ac.id] = n.id;
    for (const c of n.children ?? []) visit(c);
  };
  visit(root);
  return out;
};

/** The smallest body that has structure: a root decomposed into two leaves. */
const twoLeafBody = (): any => {
  const b = clone(minimalBody()) as any;
  b.tree = branchNode("REQ-ROOT", undefined, "limit-amendment.root", [
    leafNode("REQ-ROOT.1", "REQ-ROOT", "child.one"),
    leafNode("REQ-ROOT.2", "REQ-ROOT", "child.two"),
  ]);
  b.traceability = traceOf(b.tree);
  return b;
};

/**
 * A chain `depth` levels deep. Each branch also carries a sibling leaf, so the
 * body has at least two children everywhere and leaves at mixed depths — no
 * TREE-002 and no TREE-006 noise to confuse the assertion under test.
 */
const chainBody = (depth: number): any => {
  const idAt = (d: number) => (d === 1 ? "REQ-ROOT" : `REQ-ROOT${".1".repeat(d - 1)}`);
  let node = leafNode(idAt(depth), idAt(depth - 1), `deep.${depth}`);
  for (let d = depth - 1; d >= 2; d -= 1) {
    node = branchNode(idAt(d), idAt(d - 1), `mid.${d}`, [
      node,
      leafNode(`${idAt(d)}.2`, idAt(d), `sib.${d}`),
    ]);
  }
  const b = clone(minimalBody()) as any;
  b.tree = branchNode("REQ-ROOT", undefined, "limit-amendment.root", [
    node,
    leafNode("REQ-ROOT.2", "REQ-ROOT", "sib.1"),
  ]);
  b.traceability = traceOf(b.tree);
  return b;
};

/** The node at the bottom of a `chainBody` chain. */
const deepest = (n: any): any => (n.children?.length ? deepest(n.children[0]) : n);

describe("the registry", () => {
  it("registers every task-6 check exactly once", () => {
    const registered = allChecks().map((c) => c.id);
    for (const id of TASK_6_CHECKS) {
      expect(registered.filter((r) => r === id)).toEqual([id]);
    }
  });

  // Task 6 asserted here that the META and GATE families were ABSENT, which was
  // true of task 6 and is the thing task 7 exists to make false. The assertion is
  // inverted rather than deleted: both families are now registered, and the gate
  // is not a gate without them.
  it("registers the META and GATE families task 7 added", () => {
    const ids = allChecks().map((c) => c.id);
    expect(ids.filter((i) => i.startsWith("META-"))).toEqual(["META-001", "META-002", "META-003"]);
    expect(ids.filter((i) => i.startsWith("GATE-"))).toEqual([
      "GATE-001",
      "GATE-002",
      "GATE-003",
      "GATE-006",
    ]);
  });

  // Task 6 read "error everywhere except TREE-006". Task 7 adds exactly two more
  // warnings, and the enumeration stays exhaustive so a THIRD one cannot be
  // introduced quietly: a check that only warns cannot refuse anything.
  it("severities are error everywhere except TREE-006, AC-005 and CLARIFY-006", () => {
    const warnings = allChecks()
      .filter((c) => c.severity === "warning")
      .map((c) => c.id);
    expect(warnings).toEqual(["TREE-006", "AC-005", "CLARIFY-006"]);
  });
});

describe("no check false-positives on the clean body", () => {
  it("the clean body produces no findings at all, not merely no errors", async () => {
    expect((await analyse(clone(minimalBody()))).findings).toEqual([]);
  });

  it.each(TASK_6_CHECKS)("%s stays silent on the clean body", async (id) => {
    expect(await fire(id, clone(minimalBody()))).toEqual([]);
  });
});

describe("SCHEMA-001 — an unparseable body never reaches the other checks", () => {
  it("refuses a body that is not a body, naming each zod issue", async () => {
    const r = await analyse({});
    expect(r.findings.map((f) => f.id)).toContain("SCHEMA-001");
    expect(r.findings.every((f) => f.id === "SCHEMA-001")).toBe(true);
    expect(r.ok).toBe(false);
    // a skipped run is a run of ONE check, not a silent pass of nineteen
    expect(r.checksRun).toBe(1);
  });

  it("names the offending path and the schema version expected", async () => {
    const b = clone(minimalBody()) as any;
    b.schemaVersion = "9.9";
    const f = (await analyse(b)).findings.find((x) => x.id === "SCHEMA-001");
    expect(f?.path).toBe("schemaVersion");
    // The old assertion was `toContain("schemaVersion 1.0")`, which the message
    // prefix satisfied unconditionally — it passed for any SCHEMA-001 finding on
    // any body, including one with nothing wrong with its version. This asserts
    // the zod issue itself, which only a version mismatch produces.
    expect(f?.message).toContain('expected "1.0"');
    expect(f?.message).toContain("does not declare schemaVersion 1.0");
  });

  it("does NOT announce an unrelated schema issue as a version mismatch", async () => {
    // A missing workItem is not a version problem, and a refusal read from a
    // stage must not say it is.
    const b = clone(minimalBody()) as any;
    delete b.metadata.workItem;
    const f = (await analyse(b)).findings.find((x) => x.id === "SCHEMA-001");
    expect(f?.path).toBe("metadata.workItem");
    expect(f?.message).not.toContain("schemaVersion");
    expect(f?.message).toContain("does not satisfy the requirements schema");
  });

  it("also fires as a check when a caller runs the checks over an unvalidated body", async () => {
    const found = await fire("SCHEMA-001", { schemaVersion: "1.0" });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.id === "SCHEMA-001")).toBe(true);
  });
});

describe("SCHEMA-002 — a child id must extend its parent's", () => {
  it("refuses an id whose tail is not a single positive integer", async () => {
    const b = twoLeafBody();
    b.tree.children[1].id = "REQ-ROOT.2.3";
    const f = (await analyse(b)).findings.find((x) => x.id === "SCHEMA-002");
    expect(f?.path).toBe("REQ-ROOT.2.3.id");
    expect(f?.message).toContain('expected "REQ-ROOT.<n>"');
    expect(f?.message).toContain('"2.3"');
  });

  it("refuses a zero index — n must be positive", async () => {
    const b = twoLeafBody();
    b.tree.children[1].id = "REQ-ROOT.0";
    expect(await ids(b)).toContain("SCHEMA-002");
  });

  it("accepts a sparse but positive index", async () => {
    const b = twoLeafBody();
    b.tree.children[1].id = "REQ-ROOT.9";
    expect(await ids(b)).not.toContain("SCHEMA-002");
  });
});

describe("SCHEMA-003 — parentId must name the actual parent", () => {
  it("refuses a root that carries parentId", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.parentId = "REQ-NOWHERE";
    const f = (await analyse(b)).findings.find((x) => x.id === "SCHEMA-003");
    expect(f?.path).toBe("REQ-ROOT.parentId");
    expect(f?.message).toContain("REQ-NOWHERE");
    expect(f?.message).toContain("absent");
  });

  it("refuses a non-root that omits parentId", async () => {
    const b = twoLeafBody();
    delete b.tree.children[1].parentId;
    const f = (await analyse(b)).findings.find((x) => x.id === "SCHEMA-003");
    expect(f?.message).toContain('expected "REQ-ROOT", found none');
  });

  it("refuses a parentId that names a node which is not the actual parent", async () => {
    const b = twoLeafBody();
    b.tree.children[1].parentId = "REQ-ROOT.1";
    const f = (await analyse(b)).findings.find((x) => x.id === "SCHEMA-003");
    expect(f?.message).toContain('parentId "REQ-ROOT.1"');
    expect(f?.message).toContain('expected "REQ-ROOT"');
  });
});

describe("SCHEMA-004 — structural keys are absent, never empty", () => {
  it("refuses a leaf carrying an EMPTY children array, distinguishing it from absence", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.children = [];
    const f = (await analyse(b)).findings.find((x) => x.id === "SCHEMA-004");
    expect(f?.path).toBe("REQ-ROOT.children");
    expect(f?.message).toContain("present with 0 entries");
    expect(f?.message).toContain("expected absent");
  });

  it("refuses a leaf carrying children", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.children = [leafNode("REQ-ROOT.1", "REQ-ROOT", "child.one")];
    expect(await ids(b)).toContain("SCHEMA-004");
  });

  it("refuses a branch carrying acceptanceCriteria", async () => {
    const b = twoLeafBody();
    b.tree.acceptanceCriteria = clone(minimalBody()).tree.acceptanceCriteria;
    const f = (await analyse(b)).findings.find((x) => x.id === "SCHEMA-004");
    expect(f?.path).toBe("REQ-ROOT.acceptanceCriteria");
    expect(f?.message).toContain("present with 1 entry");
  });
});

describe("SCHEMA-005 — an unrecognised decision is never assumed benign", () => {
  it("refuses a forged node decision", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.decision = "signed";
    const found = await fire("SCHEMA-005", b);
    expect(found.map((f) => f.path)).toContain("REQ-ROOT.decision");
    expect(found[0]?.message).toContain('"signed"');
    expect(found[0]?.message).toContain("leaf, decompose, clarify");
  });

  it("refuses a forged decision inside the score history", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.scoreHistory[0].decision = "approved";
    const found = await fire("SCHEMA-005", b);
    expect(found.map((f) => f.path)).toContain("REQ-ROOT.scoreHistory.0.decision");
  });
});

describe("TREE-003 — the recursion ceiling", () => {
  it("refuses a node below maxDepth", async () => {
    const f = (await analyse(chainBody(7))).findings.find((x) => x.id === "TREE-003");
    expect(f?.message).toContain("depth 7");
    expect(f?.message).toContain("maxDepth 6");
  });

  it("permits a tree that stops exactly at maxDepth", async () => {
    expect(await ids(chainBody(6))).not.toContain("TREE-003");
  });
});

describe("TREE-004 — a branch at the ceiling must escalate", () => {
  const atTheCeiling = () => {
    const b = chainBody(6);
    const node = deepest(b.tree);
    node.decision = "clarify";
    node.isLeaf = false;
    delete node.acceptanceCriteria;
    node.score = { unknowns: 8, complexity: 8, magnitude: 8, decision: "clarify", at: AT };
    node.scoreHistory = [{ ...node.score }];
    return { b, id: node.id as string };
  };

  it("refuses a non-leaf at maxDepth with neither a clarification nor a residual", async () => {
    const { b, id } = atTheCeiling();
    const f = (await analyse(b)).findings.find((x) => x.id === "TREE-004");
    expect(f?.path).toBe(id);
    expect(f?.message).toContain("maxDepth 6");
    expect(f?.message).toContain("residualRef none");
  });

  it("accepts the same node once a clarification references it", async () => {
    const { b, id } = atTheCeiling();
    b.clarifications = [{ id: "CL-1", nodeId: id, question: "Which cutoff applies?" }];
    expect(await ids(b)).not.toContain("TREE-004");
  });

  it("accepts the same node once it carries a residualRef", async () => {
    const { b, id } = atTheCeiling();
    deepest(b.tree).residualRef = "RU-1";
    b.residuals = [
      {
        id: "RU-1",
        kind: "ResidualUncertainty",
        nodeId: id,
        statement: "The staleness cutoff is unconfirmed.",
        acceptedBy: { kind: "human", name: "A. Mehta" },
        acceptedAt: AT,
      },
    ];
    expect(await ids(b)).not.toContain("TREE-004");
  });
});

describe("TREE-005 — node keys are unique", () => {
  it("refuses two nodes sharing a nodeKey, naming both", async () => {
    const b = twoLeafBody();
    b.tree.children[1].nodeKey = b.tree.children[0].nodeKey;
    const f = (await analyse(b)).findings.find((x) => x.id === "TREE-005");
    expect(f?.path).toBe("REQ-ROOT.2.nodeKey");
    expect(f?.message).toContain('"child.one"');
    expect(f?.message).toContain('"REQ-ROOT.1"');
    expect(f?.message).toContain('"REQ-ROOT.2"');
  });
});

describe("TREE-006 — uniform depth does not fire on a single leaf or on mixed depths", () => {
  it("stays silent when the leaves sit at different depths", async () => {
    expect(await ids(chainBody(4))).not.toContain("TREE-006");
  });

  it("stays silent on a lone leaf", async () => {
    expect(await ids(clone(minimalBody()))).not.toContain("TREE-006");
  });
});

/**
 * The defect TREE-007 exists for: a tree that never bottoms out. AC-001 only
 * asks LEAVES for acceptance criteria, so a body of nothing but branches
 * satisfies it vacuously — and one with zero leaves and zero acceptance criteria
 * passed the entire gate on that technicality.
 */
const leaflessBody = (): any => {
  const clarifyNode = (id: string, key: string): any => ({
    id,
    parentId: "REQ-ROOT",
    nodeKey: key,
    statement: `unresolved ${id}`,
    score: { unknowns: 8, complexity: 8, magnitude: 8, decision: "clarify", at: AT },
    scoreHistory: [{ unknowns: 8, complexity: 8, magnitude: 8, decision: "clarify", at: AT }],
    decision: "clarify",
    isLeaf: false,
    grounding: [],
  });
  const b = clone(minimalBody()) as any;
  b.tree = branchNode("REQ-ROOT", undefined, "limit-amendment.root", [
    clarifyNode("REQ-ROOT.1", "child.one"),
    clarifyNode("REQ-ROOT.2", "child.two"),
  ]);
  b.clarifications = [1, 2].map((n) => ({
    id: `CL-${n}`,
    nodeId: `REQ-ROOT.${n}`,
    question: "Which staleness cutoff applies?",
    answer: { freetext: "five seconds" },
  }));
  b.traceability = {};
  return b;
};

describe("TREE-007 — an artefact that specifies nothing is not certifiable", () => {
  it("refuses a tree with no leaves at all, which every other check passed", async () => {
    const r = await analyse(leaflessBody());
    const f = r.findings.find((x) => x.id === "TREE-007");
    expect(f?.path).toBe("tree");
    expect(f?.message).toContain("3 nodes and not one of them is a leaf");
    expect(f?.message).toContain("expected at least 1");
    expect(r.ok).toBe(false);
  });

  it("is the ONLY refusal on that body — the rest of the gate really did pass it", async () => {
    // The bug verbatim: without TREE-007 this body has no error-severity finding
    // at all, and an empty grounding table and an empty AC list are certified.
    const r = await analyse(leaflessBody());
    expect(r.findings.map((x) => x.id)).toEqual(["TREE-007"]);
  });

  it("stays silent on the minimal body, whose root is itself a leaf", async () => {
    expect(await fire("TREE-007", clone(minimalBody()))).toEqual([]);
    expect(await ids(clone(minimalBody()))).not.toContain("TREE-007");
  });

  it("stays silent whenever the tree bottoms out somewhere", async () => {
    expect(await ids(twoLeafBody())).not.toContain("TREE-007");
    expect(await ids(chainBody(4))).not.toContain("TREE-007");
  });
});

describe("SCORE-001 — the message is read aloud, so it carries both values", () => {
  it("states the stored band, the recomputed band and the inputs", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.score.magnitude = 21;
    const f = (await analyse(b)).findings.find((x) => x.id === "SCORE-001");
    expect(f?.path).toBe("REQ-ROOT.score.magnitude");
    expect(f?.message).toBe("stored magnitude 21, recomputed 2 from U=1 C=2");
  });

  it("checks every history entry too, not only the current score", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.scoreHistory[0].magnitude = 13;
    const f = (await analyse(b)).findings.find((x) => x.id === "SCORE-001");
    expect(f?.path).toBe("REQ-ROOT.scoreHistory.0.magnitude");
    expect(f?.message).toContain("recomputed 2 from U=1 C=2");
  });
});

describe("SCORE-002 — the bands are Fibonacci or they are nothing", () => {
  it("refuses an off-band unknowns", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.score.unknowns = 4;
    const found = await fire("SCORE-002", b);
    expect(found.map((f) => f.path)).toContain("REQ-ROOT.score.unknowns");
    expect(found[0]?.message).toContain("1, 2, 3, 5, 8, 13, 21");
  });

  it("refuses an off-band complexity in the history", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.scoreHistory[0].complexity = 6;
    const found = await fire("SCORE-002", b);
    expect(found.map((f) => f.path)).toContain("REQ-ROOT.scoreHistory.0.complexity");
  });
});

describe("SCORE-003 — the current score is the last pass, exactly", () => {
  it("refuses a score that has drifted from the final history entry", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.score.at = LATER;
    const f = (await analyse(b)).findings.find((x) => x.id === "SCORE-003");
    expect(f?.path).toBe("REQ-ROOT.score");
    expect(f?.message).toContain(LATER);
    expect(f?.message).toContain(AT);
  });

  it("refuses a score with no history behind it at all", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.scoreHistory = [];
    const found = await fire("SCORE-003", b);
    expect(found[0]?.path).toBe("REQ-ROOT.scoreHistory");
    expect(found[0]?.message).toContain("expected at least one pass");
  });
});

describe("SCORE-005 — history runs forwards", () => {
  it("refuses a pass stamped before the one it follows", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.scoreHistory = [
      { unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at: LATER },
      { unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at: AT },
    ];
    b.tree.score = { ...b.tree.scoreHistory[1] };
    const f = (await analyse(b)).findings.find((x) => x.id === "SCORE-005");
    expect(f?.path).toBe("REQ-ROOT.scoreHistory.1.at");
    expect(f?.message).toContain(AT);
    expect(f?.message).toContain(LATER);
  });

  it("permits two passes sharing a stamp — non-decreasing, not increasing", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.scoreHistory = [
      { unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at: AT },
      { unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at: AT },
    ];
    expect(await ids(b)).not.toContain("SCORE-005");
  });
});

describe("UNCERT-002 — a residual is carried on a named human's authority", () => {
  const residual = (acceptedBy: unknown) => {
    const b = clone(minimalBody()) as any;
    b.residuals = [
      {
        id: "RU-1",
        kind: "ResidualUncertainty",
        nodeId: "REQ-ROOT",
        statement: "The staleness cutoff is unconfirmed.",
        acceptedBy,
        acceptedAt: AT,
      },
    ];
    return b;
  };

  it("refuses a residual accepted by anything other than a human", async () => {
    const found = await fire("UNCERT-002", residual({ kind: "agent", name: "copilot" }));
    expect(found.map((f) => f.path)).toEqual(["residuals.0.acceptedBy.kind"]);
    expect(found[0]?.message).toContain('"agent"');
    expect(found[0]?.message).toContain('expected "human"');
  });

  it("refuses a residual accepted by an unnamed human", async () => {
    const found = await fire("UNCERT-002", residual({ kind: "human", name: "   " }));
    expect(found.map((f) => f.path)).toEqual(["residuals.0.acceptedBy.name"]);
    expect(found[0]?.message).toContain("expected a non-empty human name");
  });

  it("accepts a residual accepted by a named human", async () => {
    expect(await fire("UNCERT-002", residual({ kind: "human", name: "A. Mehta" }))).toEqual([]);
  });
});

describe("UNCERT-005 — decomposing an inherent unknown is blind", () => {
  it("refuses a second decompose that did not move the unknowns", async () => {
    const b = twoLeafBody();
    b.tree.scoreHistory = [
      { unknowns: 8, complexity: 8, magnitude: 8, decision: "decompose", at: AT },
      { unknowns: 8, complexity: 8, magnitude: 8, decision: "decompose", at: LATER },
    ];
    b.tree.score = { ...b.tree.scoreHistory[1] };
    const f = (await analyse(b)).findings.find((x) => x.id === "UNCERT-005");
    expect(f?.path).toBe("REQ-ROOT.scoreHistory.1.decision");
    expect(f?.message).toContain("clarify floor 5");
    expect(f?.message).toContain("unknowns 8");
  });

  it("stays silent when the unknowns actually fell", async () => {
    const b = twoLeafBody();
    b.tree.scoreHistory = [
      { unknowns: 13, complexity: 8, magnitude: 13, decision: "decompose", at: AT },
      { unknowns: 8, complexity: 8, magnitude: 8, decision: "decompose", at: LATER },
    ];
    b.tree.score = { ...b.tree.scoreHistory[1] };
    expect(await ids(b)).not.toContain("UNCERT-005");
  });

  it("stays silent below the clarify floor, where clarify is inadmissible anyway", async () => {
    const b = twoLeafBody();
    b.tree.score = { unknowns: 3, complexity: 8, magnitude: 8, decision: "decompose", at: LATER };
    b.tree.scoreHistory = [
      { unknowns: 3, complexity: 8, magnitude: 8, decision: "decompose", at: AT },
      { ...b.tree.score },
    ];
    expect(await ids(b)).not.toContain("UNCERT-005");
  });
});

describe("the gate", () => {
  it("exit mode is the default and any error blocks", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.score.magnitude = 21;
    expect((await analyse(b)).ok).toBe(false);
    expect((await analyse(b, { mode: "exit" })).ok).toBe(false);
  });

  it("lint mode downgrades ONLY the GATE family — a SCORE error still blocks", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.score.magnitude = 21;
    const r = await analyse(b, { mode: "lint" });
    expect(r.findings.find((f) => f.id === "SCORE-001")?.severity).toBe("error");
    expect(r.ok).toBe(false);
  });

  it("a warning alone never blocks", async () => {
    const r = await analyse(twoLeafBody());
    expect(r.findings.map((f) => f.id)).toEqual(["TREE-006"]);
    expect(r.ok).toBe(true);
  });

  // Task 6 asserted the same count either way, because CLARIFY-005 — the only
  // check that needs a resolver — did not exist yet. It does now, so a run with
  // no resolver is one check SHORT, and the count is what records the omission.
  it("counts every registered check, one fewer when no resolver is injected", async () => {
    const clean = clone(minimalBody());
    expect((await analyse(clean)).checksRun).toBe(allChecks().length - 1);
    const withDoc = await analyse(clean, { resolveDoc: async () => null });
    expect(withDoc.checksRun).toBe(allChecks().length);
  });
});

describe("every finding is legible from the stage", () => {
  it("carries a precise path and a message stating observed and expected", async () => {
    const b = twoLeafBody();
    b.tree.children[1].nodeKey = b.tree.children[0].nodeKey;
    b.tree.children[1].score.magnitude = 21;
    b.tree.children[0].parentId = "REQ-ROOT.9";
    const r = await analyse(b);
    expect(r.findings.length).toBeGreaterThan(2);
    for (const f of r.findings) {
      expect(f.id).toMatch(/^[A-Z]+-\d{3}$/);
      expect(f.path.length).toBeGreaterThan(0);
      expect(f.path.startsWith("REQ-ROOT")).toBe(true);
      expect(f.message.length).toBeGreaterThan(20);
      expect(f.message).toMatch(/expected|recomputed|already used/);
    }
  });
});

describe("CLARIFY-005 — a citation cannot be fabricated", () => {
  const grounded = () => {
    const b = clone(minimalBody());
    b.tree.grounding = [
      {
        source: "confluence",
        docId: "confluence:page:ptrd-2",
        title: "Gateway Notes",
        quote: "PSR check itself is meant to stay under about 40us",
        retrievedAt: "2026-07-30T00:00:00.000Z",
        hedged: false,
      },
    ];
    return b;
  };
  const doc = async () =>
    "Order path is tight. PSR check itself is meant to stay under about 40us, which is why it reads the local snapshot.";

  it("accepts a quote that is verbatim in the cited document", async () => {
    const r = await analyse(grounded(), { resolveDoc: doc });
    expect(r.findings.map((f) => f.id)).not.toContain("CLARIFY-005");
  });

  it("refuses a quote altered by a single word", async () => {
    const b = grounded();
    b.tree.grounding[0]!.quote = "PSR check itself is meant to stay under about 40ms";
    const r = await analyse(b, { resolveDoc: doc });
    expect(r.findings.map((f) => f.id)).toContain("CLARIFY-005");
    expect(r.ok).toBe(false);
  });

  it("refuses a citation whose document cannot be resolved at all", async () => {
    const r = await analyse(grounded(), { resolveDoc: async () => null });
    expect(r.findings.map((f) => f.id)).toContain("CLARIFY-005");
  });

  it("is skipped, not silently passed, when no resolver is injected", async () => {
    const withResolver = await analyse(grounded(), { resolveDoc: doc });
    const without = await analyse(grounded());
    expect(without.checksRun).toBe(withResolver.checksRun - 1);
  });
});

describe("CLARIFY-006 — a hedged source must not be laundered into a fact", () => {
  it("warns when a hedged quote carries no residual", async () => {
    const b = clone(minimalBody());
    b.tree.grounding = [
      {
        source: "confluence",
        docId: "confluence:page:ptrd-2",
        title: "Gateway Notes",
        quote: "There's a staleness cutoff, I think 5s",
        retrievedAt: "2026-07-30T00:00:00.000Z",
        hedged: true,
      },
    ];
    const r = await analyse(b);
    expect(r.findings.find((f) => f.id === "CLARIFY-006")?.severity).toBe("warning");
  });
});

describe("GATE — the AI cannot sign its own homework", () => {
  const signed = (kind: string, result = "partial") => {
    const b = clone(minimalBody());
    (b as any).signoff = {
      approvers: [
        { name: "d.mercer", role: "PO", kind, at: "2026-07-30T02:00:00.000Z" },
        { name: "s.iyer", role: "TechLead", kind, at: "2026-07-30T02:00:00.000Z" },
        { name: "n.okafor", role: "QA", kind, at: "2026-07-30T02:00:00.000Z" },
      ],
      result,
    };
    return b;
  };

  it("accepts a human sign-off with all three roles", async () => {
    expect((await analyse(signed("human"))).ok).toBe(true);
  });
  it("refuses an agent as approver", async () => {
    const r = await analyse(signed("agent"));
    expect(r.findings.map((f) => f.id)).toContain("GATE-006");
    expect(r.ok).toBe(false);
  });
  it("refuses a self-issued pass", async () => {
    expect((await analyse(signed("human", "passed"))).findings.map((f) => f.id)).toContain(
      "GATE-001",
    );
  });
  it("refuses a sign-off missing a required role", async () => {
    const b = signed("human");
    (b as any).signoff.approvers.pop();
    expect((await analyse(b)).findings.map((f) => f.id)).toContain("GATE-003");
  });
});

describe("DEFER-001 — 'decide later' is not a completion state", () => {
  it("refuses a deferral marker in an authored statement", async () => {
    const b = clone(minimalBody());
    b.tree.statement = "Risk Ops can amend a limit intraday. Effective timing TBD.";
    expect((await analyse(b)).findings.map((f) => f.id)).toContain("DEFER-001");
  });

  it("does NOT fire on a verbatim quote that contains someone else's TODO", async () => {
    const b = clone(minimalBody());
    b.tree.grounding = [
      {
        source: "confluence",
        docId: "confluence:page:ptrd-2",
        title: "Gateway Notes",
        quote: "TODO: document the add-on factor refresh properly",
        retrievedAt: "2026-07-30T00:00:00.000Z",
        hedged: false,
      },
    ];
    expect((await analyse(b)).findings.map((f) => f.id)).not.toContain("DEFER-001");
  });
});

describe("META-002 — derived fields are generated, never authored", () => {
  it("refuses a hand-edited traceability index", async () => {
    const b = clone(minimalBody());
    b.traceability = {};
    const r = await analyse(b);
    expect(r.findings.map((f) => f.id)).toContain("META-002");
    expect(r.findings.map((f) => f.id)).toContain("TRACE-001");
  });
});

describe("the catalogue", () => {
  it("registers 46 checks across 10 families with no duplicate ids", () => {
    const all = allChecks();
    expect(all).toHaveLength(46);
    expect(new Set(all.map((c) => c.id)).size).toBe(46);
    const families = new Set(all.map((c) => c.id.split("-")[0]));
    expect(families).toEqual(
      new Set([
        "SCHEMA",
        "SCORE",
        "TREE",
        "AC",
        "CLARIFY",
        "UNCERT",
        "DEFER",
        "TRACE",
        "GATE",
        "META",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Beyond the brief, again: each of the 26 checks task 7 adds is proved to FIRE
// on a body stating exactly that defect, and to stay SILENT on the clean one.
// ---------------------------------------------------------------------------

const TASK_7_CHECKS = [
  "SCHEMA-006",
  "SCHEMA-007",
  "META-001",
  "META-002",
  "META-003",
  "AC-001",
  "AC-002",
  "AC-003",
  "AC-004",
  "AC-005",
  "AC-006",
  "DEFER-001",
  "DEFER-002",
  "CLARIFY-001",
  "CLARIFY-002",
  "CLARIFY-003",
  "CLARIFY-004",
  "CLARIFY-005",
  "CLARIFY-006",
  "TRACE-001",
  "TRACE-002",
  "TRACE-007",
  "GATE-001",
  "GATE-002",
  "GATE-003",
  "GATE-006",
];

/** Added after task 7, and held to the same two obligations as everything above:
 *  it fires on a body stating exactly its defect, and it is silent on the clean
 *  one. TREE-007 closes AC-001's vacuous case — a tree with no leaves. */
const LATER_CHECKS = ["TREE-007"];

describe("no task-7 check false-positives on the clean body", () => {
  it.each([...TASK_7_CHECKS, ...LATER_CHECKS])("%s stays silent on the clean body", async (id) => {
    expect(await fire(id, clone(minimalBody()))).toEqual([]);
  });
});

describe("SCHEMA-006 — the root is REQ-ROOT, exactly", () => {
  it("refuses a tree re-rooted one level down, which the id pattern alone accepts", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.id = "REQ-ROOT.1";
    const r = await analyse(b);
    const f = r.findings.find((x) => x.id === "SCHEMA-006");
    expect(f?.path).toBe("REQ-ROOT.1.id");
    expect(f?.message).toContain('the root node is "REQ-ROOT.1"');
    expect(f?.message).toContain('expected exactly "REQ-ROOT"');
    expect(r.ok).toBe(false);
  });
});

describe("SCHEMA-007 — node ids are unique", () => {
  it("refuses two siblings sharing an id, naming both by nodeKey", async () => {
    const b = twoLeafBody();
    b.tree.children[1].id = "REQ-ROOT.1";
    const r = await analyse(b);
    const f = r.findings.find((x) => x.id === "SCHEMA-007");
    expect(f?.path).toBe("REQ-ROOT.1.id");
    expect(f?.message).toContain('"child.one"');
    expect(f?.message).toContain('"child.two"');
    expect(f?.message).toContain("expected every node id to be unique");
    expect(r.ok).toBe(false);
  });
});

describe("META-001 — the staleness pin", () => {
  it("refuses an updatedAt earlier than createdAt, naming both stamps", async () => {
    const b = clone(minimalBody()) as any;
    b.metadata.updatedAt = "2026-07-29T00:00:00.000Z";
    const f = (await analyse(b)).findings.find((x) => x.id === "META-001");
    expect(f?.path).toBe("metadata.updatedAt");
    expect(f?.message).toContain("2026-07-29T00:00:00.000Z");
    expect(f?.message).toContain(AT);
  });

  it("refuses an unparseable updatedAt", async () => {
    const b = clone(minimalBody()) as any;
    b.metadata.updatedAt = "later today";
    const ids7 = (await analyse(b)).findings.map((f) => f.id);
    expect(ids7).toContain("META-001");
    expect(ids7).toContain("META-003");
  });

  it("refuses an absent updatedAt when a caller runs the checks directly", async () => {
    const b = clone(minimalBody()) as any;
    delete b.metadata.updatedAt;
    const found = await fire("META-001", b);
    expect(found[0]?.message).toContain("metadata.updatedAt is absent");
  });
});

describe("META-003 — an unparseable stamp used to disarm SCORE-005 completely", () => {
  const reversedWithProse = () => {
    const b = clone(minimalBody()) as any;
    b.tree.scoreHistory = [
      { unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at: "much later" },
      { unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at: "2020-01-01T00:00:00Z" },
    ];
    b.tree.score = { ...b.tree.scoreHistory[1] };
    return b;
  };

  it("SCORE-005 cannot judge a blatantly reversed history it cannot parse", async () => {
    // Documented, not endorsed: this is precisely why META-003 exists. SCORE-005
    // compares instants and has nothing to compare when one side is prose.
    expect(await ids(reversedWithProse())).not.toContain("SCORE-005");
  });

  it("but the artefact is still refused, by name, for the unparseable stamp", async () => {
    const r = await analyse(reversedWithProse());
    const f = r.findings.find((x) => x.id === "META-003");
    expect(f?.path).toBe("REQ-ROOT.scoreHistory.0.at");
    expect(f?.message).toContain('"much later"');
    expect(f?.message).toContain("Date.parse cannot read");
    expect(f?.message).toContain("2026-07-30T00:00:00.000Z");
    expect(r.ok).toBe(false);
  });

  it("scans grounding, residual and approver stamps too, not only the score history", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.grounding = [
      {
        source: "confluence",
        docId: "confluence:page:ptrd-2",
        title: "Gateway Notes",
        quote: "the local snapshot is read on the order path",
        retrievedAt: "whenever",
        hedged: false,
      },
    ];
    b.residuals = [
      {
        id: "RU-1",
        kind: "ResidualUncertainty",
        nodeId: "REQ-ROOT",
        statement: "The staleness cutoff is unconfirmed.",
        acceptedBy: { kind: "human", name: "A. Mehta" },
        acceptedAt: "soon",
      },
    ];
    b.signoff = {
      approvers: [{ name: "d.mercer", role: "PO", kind: "human", at: "yesterday" }],
      result: "partial",
    };
    const paths = (await analyse(b)).findings.filter((f) => f.id === "META-003").map((f) => f.path);
    expect(paths).toContain("REQ-ROOT.grounding.0.retrievedAt");
    expect(paths).toContain("residuals.0.acceptedAt");
    expect(paths).toContain("signoff.approvers.0.at");
  });
});

describe("SCORE-002 reaches the stage, rather than hiding behind zod", () => {
  it("refuses an off-band unknowns through analyse, in the scorer's own words", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.score.unknowns = 4;
    b.tree.scoreHistory[0].unknowns = 4;
    const r = await analyse(b);
    const found = r.findings.map((f) => f.id);
    expect(found).toContain("SCORE-002");
    // The whole point of loosening the band: this must NOT be announced as a
    // schema problem carrying zod's "Invalid input".
    expect(found).not.toContain("SCHEMA-001");
    const f = r.findings.find((x) => x.id === "SCORE-002");
    expect(f?.path).toBe("REQ-ROOT.score.unknowns");
    expect(f?.message).toBe(
      "unknowns 4 is not a Fibonacci band; expected one of 1, 2, 3, 5, 8, 13, 21",
    );
    expect(r.ok).toBe(false);
  });
});

describe("AC — a leaf is finished when it says how it will be checked", () => {
  it("AC-001 refuses a leaf with no acceptance criteria, and nothing else", async () => {
    const b = clone(minimalBody()) as any;
    delete b.tree.acceptanceCriteria;
    b.traceability = {};
    const r = await analyse(b);
    expect(r.findings.map((f) => f.id)).toEqual(["AC-001"]);
    expect(r.findings[0]?.path).toBe("REQ-ROOT.acceptanceCriteria");
    expect(r.findings[0]?.message).toContain("carries 0 acceptance criteria");
    expect(r.findings[0]?.message).toContain("expected at least 1");
  });

  it("AC-002 refuses a blank given", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.acceptanceCriteria[0].given = "   ";
    const f = (await analyse(b)).findings.find((x) => x.id === "AC-002");
    expect(f?.path).toBe("REQ-ROOT.acceptanceCriteria.0.given");
    expect(f?.message).toContain("AC-1 has a blank given");
  });

  it("AC-002 refuses a blank outcome inside a non-empty then", async () => {
    const b = clone(minimalBody()) as any;
    // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
    b.tree.acceptanceCriteria[0].then = ["   "];
    b.tree.acceptanceCriteria[0].observable = false;
    const paths = (await analyse(b)).findings.filter((f) => f.id === "AC-002").map((f) => f.path);
    expect(paths).toEqual(["REQ-ROOT.acceptanceCriteria.0.then.0"]);
  });

  it("AC-003 refuses an empty then array", async () => {
    const b = clone(minimalBody()) as any;
    // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
    b.tree.acceptanceCriteria[0].then = [];
    const found = await fire("AC-003", b);
    expect(found[0]?.path).toBe("REQ-ROOT.acceptanceCriteria.0.then");
    expect(found[0]?.message).toContain("expected at least 1");
  });

  it("AC-004 refuses one AC id used on two nodes, naming both", async () => {
    const b = twoLeafBody();
    b.tree.children[1].acceptanceCriteria[0].id = b.tree.children[0].acceptanceCriteria[0].id;
    const f = (await analyse(b)).findings.find((x) => x.id === "AC-004");
    expect(f?.message).toContain('appears on node "REQ-ROOT.2"');
    expect(f?.message).toContain('already on node "REQ-ROOT.1"');
  });

  it("AC-004 refuses a malformed AC id", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.acceptanceCriteria[0].id = "AC_1";
    const found = await fire("AC-004", b);
    expect(found[0]?.path).toBe("REQ-ROOT.acceptanceCriteria.0.id");
    expect(found[0]?.message).toContain("expected the form AC-<n>");
  });

  it("AC-005 warns on an unobservable outcome without blocking", async () => {
    const b = clone(minimalBody()) as any;
    // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
    b.tree.acceptanceCriteria[0].then = ["it feels right to the desk"];
    b.tree.acceptanceCriteria[0].observable = false;
    const r = await analyse(b);
    const f = r.findings.find((x) => x.id === "AC-005");
    expect(f?.severity).toBe("warning");
    expect(f?.path).toBe("REQ-ROOT.acceptanceCriteria.0.then.0");
    expect(f?.message).toContain("names nothing a test could read");
    expect(r.ok).toBe(true);
  });

  it("AC-006 refuses an AC with no stakeholder", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.acceptanceCriteria[0].stakeholder = "   ";
    const f = (await analyse(b)).findings.find((x) => x.id === "AC-006");
    expect(f?.path).toBe("REQ-ROOT.acceptanceCriteria.0.stakeholder");
    expect(f?.message).toContain("expected the named role");
  });
});

describe("DEFER — scope is authored prose, and only authored prose", () => {
  it("DEFER-001 names the marker it found and where", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.statement = "Risk Ops can amend a limit intraday. Effective timing TBD.";
    const f = (await analyse(b)).findings.find((x) => x.id === "DEFER-001");
    expect(f?.path).toBe("REQ-ROOT.statement");
    expect(f?.message).toContain('contains "tbd"');
    expect(f?.message).toContain("Effective timing TBD.");
  });

  it("DEFER-001 scans the title, an AC clause and a residual statement", async () => {
    const b = clone(minimalBody()) as any;
    b.metadata.title = "Intraday PSR limit amendment (scope TODO)";
    b.tree.acceptanceCriteria[0].when = "credit-admin applies it — FIXME";
    b.residuals = [
      {
        id: "RU-1",
        kind: "ResidualUncertainty",
        nodeId: "REQ-ROOT",
        statement: "Cutoff to be confirmed.",
        acceptedBy: { kind: "human", name: "A. Mehta" },
        acceptedAt: AT,
      },
    ];
    const paths = (await analyse(b)).findings
      .filter((f) => f.id === "DEFER-001")
      .map((f) => f.path);
    expect(paths).toContain("metadata.title");
    expect(paths).toContain("REQ-ROOT.acceptanceCriteria.0.when");
    expect(paths).toContain("residuals.0.statement");
  });

  it("DEFER-001 does not scan a clarification's grounding quote either", async () => {
    const b = clone(minimalBody()) as any;
    b.clarifications = [
      {
        id: "CL-1",
        nodeId: "REQ-ROOT",
        question: "Which staleness cutoff applies?",
        answer: { freetext: "5 seconds" },
        answeredBy: { kind: "knowledge_base", name: "eil-corpus" },
        grounding: [
          {
            source: "confluence",
            docId: "confluence:page:ptrd-2",
            title: "Gateway Notes",
            quote: "TODO: document the add-on factor refresh properly",
            retrievedAt: AT,
            hedged: false,
          },
        ],
      },
    ];
    expect(await ids(b)).not.toContain("DEFER-001");
  });

  it("DEFER-002 refuses a deferral in the recorded-decision fields, and DEFER-001 also names it", async () => {
    const b = clone(minimalBody()) as any;
    b.clarifications = [
      {
        id: "CL-1",
        nodeId: "REQ-ROOT",
        question: "Which staleness cutoff applies?",
        answer: { freetext: "unresolved" },
        resultingDetail: "Effective timing to be decided.",
      },
    ];
    b.residuals = [
      {
        id: "RU-1",
        kind: "ResidualRisk",
        nodeId: "REQ-ROOT",
        statement: "The refresh interval is unconfirmed.",
        mitigation: "TODO: agree a cap with the psr-limits team.",
        acceptedBy: { kind: "human", name: "A. Mehta" },
        acceptedAt: AT,
      },
    ];
    const found = (await analyse(b)).findings.filter((f) => f.id === "DEFER-002");
    expect(found.map((f) => f.path)).toEqual([
      "clarifications.0.resultingDetail",
      "residuals.0.mitigation",
    ]);
    expect(found[0]?.message).toContain("is a recorded decision");
    expect(found[0]?.message).toContain('contains "to be decided"');
    expect(await ids(b)).toContain("DEFER-001");
  });
});

describe("CLARIFY — a question asked, and actually answered", () => {
  it("CLARIFY-001 refuses a clarify pass with no clarification recording it", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.scoreHistory = [
      { unknowns: 8, complexity: 8, magnitude: 8, decision: "clarify", at: AT },
      { unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at: LATER },
    ];
    b.tree.score = { ...b.tree.scoreHistory[1] };
    const f = (await analyse(b)).findings.find((x) => x.id === "CLARIFY-001");
    expect(f?.path).toBe("REQ-ROOT.scoreHistory.0.decision");
    expect(f?.message).toContain("0 clarifications name it");
    expect(f?.message).toContain('expected at least 1 clarification with nodeId "REQ-ROOT"');
  });

  it("CLARIFY-002 refuses an unanswered clarification, and nothing else", async () => {
    const b = clone(minimalBody()) as any;
    b.clarifications = [
      { id: "CL-1", nodeId: "REQ-ROOT", question: "Which staleness cutoff applies?" },
    ];
    const r = await analyse(b);
    expect(r.findings.map((f) => f.id)).toEqual(["CLARIFY-002"]);
    expect(r.findings[0]?.path).toBe("clarifications.0.answer");
    expect(r.findings[0]?.message).toContain("carries no answer at all");
  });

  it("CLARIFY-002 refuses an answer that chose nothing and said nothing", async () => {
    const b = clone(minimalBody()) as any;
    b.clarifications = [
      { id: "CL-1", nodeId: "REQ-ROOT", question: "Which cutoff?", answer: { freetext: "  " } },
    ];
    const f = (await analyse(b)).findings.find((x) => x.id === "CLARIFY-002");
    expect(f?.message).toContain("expected at least one of the two to be non-empty");
  });

  it("CLARIFY-003 refuses a knowledge-base answer citing nothing", async () => {
    const b = clone(minimalBody()) as any;
    b.clarifications = [
      {
        id: "CL-1",
        nodeId: "REQ-ROOT",
        question: "Which staleness cutoff applies?",
        answer: { freetext: "5 seconds" },
        answeredBy: { kind: "knowledge_base", name: "eil-corpus" },
      },
    ];
    const f = (await analyse(b)).findings.find((x) => x.id === "CLARIFY-003");
    expect(f?.path).toBe("clarifications.0.grounding");
    expect(f?.message).toContain("with 0 citations");
    expect(f?.message).toContain("expected at least 1");
  });

  it("CLARIFY-004 refuses an option with no stated consequence", async () => {
    const b = clone(minimalBody()) as any;
    b.clarifications = [
      {
        id: "CL-1",
        nodeId: "REQ-ROOT",
        question: "Which staleness cutoff applies?",
        options: [{ id: "OPT-1", text: "Five seconds", implication: "   " }],
        answer: { chosenOptionId: "OPT-1" },
      },
    ];
    const f = (await analyse(b)).findings.find((x) => x.id === "CLARIFY-004");
    expect(f?.path).toBe("clarifications.0.options.0.implication");
    expect(f?.message).toContain("option OPT-1 of CL-1");
    expect(f?.message).toContain("expected a statement of what choosing it commits");
  });
});

describe("CLARIFY-005 — the mechanics of verbatim verification", () => {
  const cite = (quote: string, docId = "confluence:page:ptrd-2") => {
    const b = clone(minimalBody()) as any;
    b.tree.grounding = [
      {
        source: "confluence",
        docId,
        title: "Gateway Notes",
        quote,
        retrievedAt: AT,
        hedged: false,
      },
    ];
    return b;
  };

  it("normalises runs of whitespace on BOTH sides", async () => {
    const b = cite("PSR check   itself is\n meant to stay");
    const r = await analyse(b, {
      resolveDoc: async () => "…PSR check itself\tis     meant to stay under 40us…",
    });
    expect(r.findings.map((f) => f.id)).not.toContain("CLARIFY-005");
  });

  it("does not case-fold: a quote is verbatim or it is not a quote", async () => {
    const r = await analyse(cite("psr check itself is meant to stay"), {
      resolveDoc: async () => "PSR check itself is meant to stay under 40us",
    });
    expect(r.findings.map((f) => f.id)).toContain("CLARIFY-005");
  });

  it("does not strip punctuation either", async () => {
    const r = await analyse(cite("stay under about 40us"), {
      resolveDoc: async () => "stay under, about 40us",
    });
    expect(r.findings.map((f) => f.id)).toContain("CLARIFY-005");
  });

  it("fetches each distinct document once, however many citations name it", async () => {
    const b = clone(minimalBody()) as any;
    const g = (docId: string, quote: string) => ({
      source: "confluence",
      docId,
      title: "Gateway Notes",
      quote,
      retrievedAt: AT,
      hedged: false,
    });
    b.tree.grounding = [
      g("confluence:page:a", "alpha"),
      g("confluence:page:a", "alpha"),
      g("confluence:page:b", "beta"),
    ];
    b.clarifications = [
      {
        id: "CL-1",
        nodeId: "REQ-ROOT",
        question: "Which cutoff?",
        answer: { freetext: "5s" },
        grounding: [g("confluence:page:a", "alpha")],
      },
    ];
    const asked: string[] = [];
    const r = await analyse(b, {
      resolveDoc: async (docId: string) => {
        asked.push(docId);
        return docId.endsWith("a") ? "alpha" : "beta";
      },
    });
    expect(asked).toEqual(["confluence:page:a", "confluence:page:b"]);
    expect(r.findings.map((f) => f.id)).not.toContain("CLARIFY-005");
  });

  it("verifies citations made by a clarification, not only by the tree", async () => {
    const b = clone(minimalBody()) as any;
    b.clarifications = [
      {
        id: "CL-1",
        nodeId: "REQ-ROOT",
        question: "Which staleness cutoff applies?",
        answer: { freetext: "5 seconds" },
        answeredBy: { kind: "knowledge_base", name: "eil-corpus" },
        grounding: [
          {
            source: "confluence",
            docId: "confluence:page:ptrd-2",
            title: "Gateway Notes",
            quote: "the cutoff is five seconds",
            retrievedAt: AT,
            hedged: false,
          },
        ],
      },
    ];
    const r = await analyse(b, { resolveDoc: async () => "the cutoff is four seconds" });
    const f = r.findings.find((x) => x.id === "CLARIFY-005");
    expect(f?.path).toBe("clarifications.0.grounding.0.quote");
  });

  it("states the quote and the document in the refusal, read-aloud ready", async () => {
    const r = await analyse(cite("PSR check itself is meant to stay under about 40ms"), {
      resolveDoc: async () => "PSR check itself is meant to stay under about 40us.",
    });
    const f = r.findings.find((x) => x.id === "CLARIFY-005");
    expect(f?.path).toBe("REQ-ROOT.grounding.0.quote");
    expect(f?.message).toContain("quote is not present verbatim in confluence:page:ptrd-2");
    expect(f?.message).toContain("40ms");
    expect(f?.message).toContain("character for character");
  });

  it("names the document that could not be resolved", async () => {
    const r = await analyse(cite("anything at all"), { resolveDoc: async () => null });
    const f = r.findings.find((x) => x.id === "CLARIFY-005");
    expect(f?.path).toBe("REQ-ROOT.grounding.0.docId");
    expect(f?.message).toContain("could not be resolved");
    expect(f?.message).toContain("confluence:page:ptrd-2");
  });
});

describe("CLARIFY-006 — a hedged quote is silenced by a residual, not by deletion", () => {
  const hedged = () => {
    const b = clone(minimalBody()) as any;
    b.tree.grounding = [
      {
        source: "confluence",
        docId: "confluence:page:ptrd-2",
        title: "Gateway Notes",
        quote: "There's a staleness cutoff, I think 5s",
        retrievedAt: AT,
        hedged: true,
      },
    ];
    return b;
  };

  it("names the node and what would silence it", async () => {
    const f = (await analyse(hedged())).findings.find((x) => x.id === "CLARIFY-006");
    expect(f?.path).toBe("REQ-ROOT.grounding.0.quote");
    expect(f?.message).toContain('expected a residual with nodeId "REQ-ROOT"');
  });

  it("stays silent once a residual names that node", async () => {
    const b = hedged();
    b.residuals = [
      {
        id: "RU-1",
        kind: "ResidualUncertainty",
        nodeId: "REQ-ROOT",
        statement: "The staleness cutoff is unconfirmed.",
        acceptedBy: { kind: "human", name: "A. Mehta" },
        acceptedAt: AT,
      },
    ];
    expect(await ids(b)).not.toContain("CLARIFY-006");
  });
});

describe("TRACE — the index and the tree agree, or the index is fiction", () => {
  it("TRACE-001 names the node the AC is actually stated on", async () => {
    const b = clone(minimalBody()) as any;
    b.traceability = {};
    const f = (await analyse(b)).findings.find((x) => x.id === "TRACE-001");
    expect(f?.path).toBe("traceability.AC-1");
    expect(f?.message).toContain("absent from the traceability index");
    expect(f?.message).toContain('expected traceability.AC-1 to be "REQ-ROOT"');
  });

  it("TRACE-001 refuses an index entry pointing at the wrong node", async () => {
    const b = twoLeafBody();
    const first = b.tree.children[0].acceptanceCriteria[0].id;
    b.traceability[first] = "REQ-ROOT.2";
    const f = (await analyse(b)).findings.find((x) => x.id === "TRACE-001");
    expect(f?.message).toContain('maps it to "REQ-ROOT.2"');
    expect(f?.message).toContain('expected "REQ-ROOT.1"');
  });

  it("TRACE-002 refuses an index naming a node that is not in the tree", async () => {
    const b = clone(minimalBody()) as any;
    b.traceability = { "AC-1": "REQ-ROOT.9" };
    const f = (await analyse(b)).findings.find((x) => x.id === "TRACE-002");
    expect(f?.path).toBe("traceability.AC-1");
    expect(f?.message).toContain('"REQ-ROOT.9", which is not in the tree');
  });

  it("TRACE-007 is registered and returns nothing, by design", async () => {
    // Reserved for refinement under a baseline. There is no baseline in phase 1,
    // so there is nothing for it to compare — the id is held, not forgotten.
    expect(allChecks().map((c) => c.id)).toContain("TRACE-007");
    expect(await fire("TRACE-007", twoLeafBody())).toEqual([]);
  });
});

describe("META-002 — every generated field, not only traceability", () => {
  const tamper = (mutate: (b: any) => void) => {
    const b = clone(minimalBody()) as any;
    mutate(b);
    return b;
  };

  it("refuses a hand-flipped isLeaf", async () => {
    const f = (
      await analyse(
        tamper((b) => {
          b.tree.isLeaf = false;
        }),
      )
    ).findings.find((x) => x.id === "META-002");
    expect(f?.path).toBe("REQ-ROOT.isLeaf");
    expect(f?.message).toContain("expected true");
  });

  it("refuses a hedged flag turned off to launder a hedged source", async () => {
    const b = tamper((b2) => {
      b2.tree.grounding = [
        {
          source: "confluence",
          docId: "confluence:page:ptrd-2",
          title: "Gateway Notes",
          quote: "There's a staleness cutoff, I think 5s",
          retrievedAt: AT,
          hedged: false,
        },
      ];
    });
    const f = (await analyse(b)).findings.find((x) => x.id === "META-002");
    expect(f?.path).toBe("REQ-ROOT.grounding.0.hedged");
    expect(f?.message).toContain("expected true");
  });

  /**
   * The assembler generates `hedged` on clarification grounding as well as on
   * tree grounding, and the projection drops the HEDGED badge when it is
   * flipped. META-002 walked the tree only, so this laundering passed the gate
   * with 46 checks and 0 findings — falsifying "editing one is detectable:
   * `check` recomputes them all". Two grounding rows, the SECOND one flipped,
   * so the path has to be index-precise and not merely present.
   */
  it("refuses a hedged flag turned off on CLARIFICATION grounding", async () => {
    const b = tamper((b2) => {
      b2.clarifications = [
        {
          id: "CL-1",
          nodeId: "REQ-ROOT",
          question: "What is the staleness cutoff for the PSR cache?",
          options: [],
          answeredBy: { kind: "knowledge_base", name: "confluence:page:ptrd-2" },
          grounding: [
            {
              source: "confluence",
              docId: "confluence:page:ptrd-1",
              title: "PSR Platform Overview",
              quote: "The psr-cache is refreshed within 250ms of an amendment",
              retrievedAt: AT,
              hedged: false,
            },
            {
              source: "confluence",
              docId: "confluence:page:ptrd-2",
              title: "Gateway Notes",
              quote: "There's a staleness cutoff, I think 5s",
              retrievedAt: AT,
              hedged: false,
            },
          ],
        },
      ];
    });
    const findings = (await analyse(b)).findings.filter((x) => x.id === "META-002");
    const f = findings.find((x) => x.path === "clarifications.0.grounding.1.hedged");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("expected true");
    // the first row is honestly unhedged — it must not be reported
    expect(findings.map((x) => x.path)).not.toContain("clarifications.0.grounding.0.hedged");
  });

  it("refuses a hand-flipped observable flag", async () => {
    const f = (
      await analyse(
        tamper((b) => {
          b.tree.acceptanceCriteria[0].observable = false;
        }),
      )
    ).findings.find((x) => x.id === "META-002");
    expect(f?.path).toBe("REQ-ROOT.acceptanceCriteria.0.observable");
    expect(f?.message).toContain("expected true");
  });

  it("refuses a hand-written coverage block", async () => {
    const f = (
      await analyse(
        tamper((b) => {
          b.coverage = {
            leaves: 9,
            acs: 1,
            unknownsTotal: 1,
            grounded: 0,
            escalated: 0,
            carried: 0,
          };
        }),
      )
    ).findings.find((x) => x.id === "META-002");
    expect(f?.path).toBe("coverage.leaves");
    expect(f?.message).toContain("found 9");
    expect(f?.message).toContain("expected 1");
  });
});

describe("GATE — the messages that get read out", () => {
  const signed = (over: Record<string, unknown> = {}) => {
    const b = clone(minimalBody()) as any;
    b.signoff = {
      approvers: [
        { name: "d.mercer", role: "PO", kind: "human", at: LATER },
        { name: "s.iyer", role: "TechLead", kind: "human", at: LATER },
        { name: "n.okafor", role: "QA", kind: "human", at: LATER },
      ],
      result: "partial",
      ...over,
    };
    return b;
  };

  it("GATE-001 names the forged result and the admissible ones", async () => {
    const f = (await analyse(signed({ result: "passed" }))).findings.find(
      (x) => x.id === "GATE-001",
    );
    expect(f?.path).toBe("signoff.result");
    expect(f?.message).toContain('result "passed"');
    expect(f?.message).toContain("expected one of partial, failed");
  });

  it("GATE-002 refuses a sign-off recorded over standing errors", async () => {
    const b = signed();
    b.analysis = {
      ranAt: LATER,
      checksRun: 45,
      findings: [
        { id: "SCORE-001", severity: "error", path: "REQ-ROOT.score.magnitude", message: "x" },
        { id: "TREE-006", severity: "warning", path: "REQ-ROOT", message: "y" },
      ],
    };
    const f = (await analyse(b)).findings.find((x) => x.id === "GATE-002");
    expect(f?.path).toBe("signoff");
    expect(f?.message).toContain("1 error-severity finding");
    expect(f?.message).toContain("SCORE-001");
    expect(f?.message).toContain("expected 0");
  });

  it("GATE-003 names exactly which role is missing", async () => {
    const b = signed();
    b.signoff.approvers = b.signoff.approvers.filter((a: any) => a.role !== "QA");
    const f = (await analyse(b)).findings.find((x) => x.id === "GATE-003");
    expect(f?.path).toBe("signoff.approvers");
    expect(f?.message).toContain("held by PO, TechLead");
    expect(f?.message).toContain("missing QA");
  });

  it("GATE-006 names the forged approver, the role, and refuses by name", async () => {
    const b = signed();
    b.signoff.approvers[1] = { name: "amp-agent", role: "TechLead", kind: "agent", at: LATER };
    const r = await analyse(b);
    const f = r.findings.find((x) => x.id === "GATE-006");
    expect(f?.path).toBe("signoff.approvers.1.kind");
    expect(f?.message).toBe(
      'approver "amp-agent" for role "TechLead" signed as kind "agent"; expected "human" — an agent cannot sign off its own requirements',
    );
    expect(r.ok).toBe(false);
  });

  it("GATE-006 fires on every forged approver, not merely the first", async () => {
    const b = signed();
    for (const a of b.signoff.approvers) a.kind = "agent";
    const found = (await analyse(b)).findings.filter((f) => f.id === "GATE-006");
    expect(found.map((f) => f.path)).toEqual([
      "signoff.approvers.0.kind",
      "signoff.approvers.1.kind",
      "signoff.approvers.2.kind",
    ]);
  });

  it("lint mode downgrades the whole GATE family, including GATE-006", async () => {
    const b = signed();
    b.signoff.approvers[0].kind = "agent";
    const r = await analyse(b, { mode: "lint" });
    expect(r.findings.find((f) => f.id === "GATE-006")?.severity).toBe("warning");
    expect(r.ok).toBe(true);
  });
});

describe("the messages that would not have survived being read aloud", () => {
  it("UNCERT-001 says something sayable when no residuals exist at all", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.score = { unknowns: 3, complexity: 3, magnitude: 3, decision: "leaf", at: AT };
    b.tree.scoreHistory = [{ ...b.tree.score }];
    const f = (await analyse(b)).findings.find((x) => x.id === "UNCERT-001");
    expect(f?.message).not.toContain("(no residuals are recorded)");
    expect(f?.message).toContain("records no residuals at all");
    expect(f?.message).toContain("accepted by a named human");
  });

  it("UNCERT-001 still enumerates the residuals when there are some", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.score = { unknowns: 3, complexity: 3, magnitude: 3, decision: "leaf", at: AT };
    b.tree.scoreHistory = [{ ...b.tree.score }];
    b.residuals = [
      {
        id: "RU-9",
        kind: "ResidualUncertainty",
        nodeId: "REQ-ROOT",
        statement: "The staleness cutoff is unconfirmed.",
        acceptedBy: { kind: "human", name: "A. Mehta" },
        acceptedAt: AT,
      },
    ];
    const f = (await analyse(b)).findings.find((x) => x.id === "UNCERT-001");
    expect(f?.message).toContain("expected one of RU-9");
  });

  it("TREE-001 handles a single admissible decision in the singular", async () => {
    const b = twoLeafBody();
    b.tree.score = { unknowns: 1, complexity: 1, magnitude: 1, decision: "decompose", at: AT };
    b.tree.scoreHistory = [{ ...b.tree.score }];
    const f = (await analyse(b)).findings.find((x) => x.id === "TREE-001");
    expect(f?.message).toContain('expected "leaf", the only admissible decision there');
    expect(f?.message).not.toContain("expected one of");
  });

  it("TREE-001 still uses the plural when more than one decision is admissible", async () => {
    const b = clone(minimalBody()) as any;
    b.tree.score = { unknowns: 3, complexity: 3, magnitude: 3, decision: "clarify", at: AT };
    b.tree.scoreHistory = [{ ...b.tree.score }];
    b.tree.decision = "clarify";
    b.tree.isLeaf = false;
    delete b.tree.acceptanceCriteria;
    b.traceability = {};
    const f = (await analyse(b)).findings.find((x) => x.id === "TREE-001");
    expect(f?.message).toContain("expected one of leaf, decompose");
  });
});

describe("the catalogue, by family", () => {
  it("holds the sizes the specification enumerates", () => {
    const size = (family: string) =>
      allChecks().filter((c) => c.id.startsWith(`${family}-`)).length;
    expect({
      SCHEMA: size("SCHEMA"),
      SCORE: size("SCORE"),
      TREE: size("TREE"),
      AC: size("AC"),
      CLARIFY: size("CLARIFY"),
      UNCERT: size("UNCERT"),
      DEFER: size("DEFER"),
      TRACE: size("TRACE"),
      GATE: size("GATE"),
      META: size("META"),
    }).toEqual({
      SCHEMA: 7,
      SCORE: 5,
      TREE: 7,
      AC: 6,
      CLARIFY: 6,
      UNCERT: 3,
      DEFER: 2,
      TRACE: 3,
      GATE: 4,
      META: 3,
    });
  });

  it("every task-6 and task-7 check id is registered exactly once", () => {
    const registered = allChecks().map((c) => c.id);
    expect(registered.length).toBe(
      TASK_6_CHECKS.length + TASK_7_CHECKS.length + LATER_CHECKS.length,
    );
    for (const id of [...TASK_6_CHECKS, ...TASK_7_CHECKS, ...LATER_CHECKS])
      expect(registered.filter((r) => r === id)).toEqual([id]);
  });
});

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

describe("eil reqs check — exit codes are the gate", () => {
  const write = (body: unknown) => {
    const p = join(mkdtempSync(join(tmpdir(), "reqs-")), "reqs.json");
    writeFileSync(p, JSON.stringify(body, null, 2));
    return p;
  };

  it("exits 0 on a clean artefact", async () => {
    const { stdout } = await run("pnpm", ["-s", "eil", "reqs", "check", write(minimalBody())]);
    expect(stdout).toContain("0 errors");
  });

  it("exits 1 and names the check on a tampered magnitude", async () => {
    const b = clone(minimalBody());
    (b.tree as any).score.magnitude = 21;
    await expect(run("pnpm", ["-s", "eil", "reqs", "check", write(b)])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("SCORE-001"),
    });
  });
});
