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

/** The smallest body that has structure: a root decomposed into two leaves. */
const twoLeafBody = (): any => {
  const b = clone(minimalBody()) as any;
  b.tree = branchNode("REQ-ROOT", undefined, "limit-amendment.root", [
    leafNode("REQ-ROOT.1", "REQ-ROOT", "child.one"),
    leafNode("REQ-ROOT.2", "REQ-ROOT", "child.two"),
  ]);
  b.traceability = {};
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
  b.traceability = {};
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

  it("registers no META or GATE family — those belong to task 7", () => {
    expect(allChecks().filter((c) => c.id.startsWith("META-"))).toEqual([]);
    expect(allChecks().filter((c) => c.id.startsWith("GATE-"))).toEqual([]);
  });

  it("severities are error everywhere except TREE-006", () => {
    const warnings = allChecks()
      .filter((c) => c.severity === "warning")
      .map((c) => c.id);
    expect(warnings).toEqual(["TREE-006"]);
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
    expect(f?.message).toContain("schemaVersion 1.0");
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

  it("counts every registered check, and the same count with a resolver injected", async () => {
    const clean = clone(minimalBody());
    expect((await analyse(clean)).checksRun).toBe(allChecks().length);
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
