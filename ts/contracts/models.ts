/**
 * Canonical document model — the shape every connector normalizes into.
 * zod gives runtime validation and inferred static types from one definition;
 * this module is the future `@eil/contracts` package shared with the
 * work-side TypeScript connector.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export const QUALITY_TIERS = ["curated", "authored", "generated", "raw"] as const;

export const CanonicalDoc = z.object({
  /** e.g. "confluence:page:12345" | "jira:issue:PAY-981" | "obsidian:note:path" */
  id: z.string(),
  tenant: z.string().default("default"),
  source: z.string(),
  title: z.string(),
  url: z.string().nullish(),
  author: z.string().nullish(),
  createdAt: z.string().nullish(), // ISO timestamps; Postgres coerces timestamptz
  updatedAt: z.string().nullish(),
  hierarchy: z.array(z.string()).default([]),
  /** empty = fail-closed (ingester-only) until the ACL syncer stamps it */
  aclGroups: z.array(z.string()).default([]),
  qualityTier: z.enum(QUALITY_TIERS).default("authored"),
  /** markdown, always */
  body: z.string(),
  /** canonical ids this doc references */
  links: z.array(z.string()).default([]),
});
export type CanonicalDoc = z.infer<typeof CanonicalDoc>;

export interface Chunk {
  docId: string;
  seq: number;
  /** breadcrumb, e.g. "Payments > Runbooks > Retry Policy" */
  headingPath: string;
  /** breadcrumb-prefixed — a chunk is self-describing in isolation */
  text: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export const contentHash = (doc: Pick<CanonicalDoc, "body">): string => sha256(doc.body);
export const chunkHash = (chunk: Pick<Chunk, "text">): string => sha256(chunk.text);
