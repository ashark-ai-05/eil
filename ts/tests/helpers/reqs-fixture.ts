/**
 * The smallest body that passes every check. Tests mutate a clone of it, so each
 * test states exactly one defect and nothing else.
 */
import type { ReqsBody } from "../../reqs/schema.js";

export function minimalBody(): ReqsBody {
  const at = "2026-07-30T00:00:00.000Z";
  return {
    schemaVersion: "1.0",
    metadata: {
      workItem: "PTR-401",
      title: "Intraday PSR limit amendment",
      deliveryType: { kind: "backend", tech: "legacy" },
      createdAt: at,
      updatedAt: at,
      executionProfile: { mode: "full" },
      generator: { agent: "copilot", model: null, version: "0.1.0", provenance: "live" },
      corpusMode: "fixtures",
    },
    tree: {
      id: "REQ-ROOT",
      nodeKey: "limit-amendment.root",
      statement: "Risk Ops can amend a counterparty PSR limit intraday.",
      score: { unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at },
      scoreHistory: [{ unknowns: 1, complexity: 2, magnitude: 2, decision: "leaf", at }],
      decision: "leaf",
      isLeaf: true,
      acceptanceCriteria: [
        {
          id: "AC-1",
          stakeholder: "Risk Ops",
          given: "an approved amendment for CPTY-ALPHA",
          when: "credit-admin applies it",
          // biome-ignore lint/suspicious/noThenProperty: Gherkin given/when/then field, required verbatim
          then: ["psr-cache reflects the new limit within 250ms"],
          observable: true,
        },
      ],
      grounding: [],
    },
    clarifications: [],
    residuals: [],
    traceability: { "AC-1": "REQ-ROOT" },
  } as ReqsBody;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
