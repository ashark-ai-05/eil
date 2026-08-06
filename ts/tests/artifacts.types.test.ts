/**
 * Negative COMPILE-TIME regressions for the transaction contract.
 *
 * Every `@ts-expect-error` below fails `tsc --noEmit` if the error it expects
 * stops occurring — so these run inside the gate that already exists, and a
 * later widening of the types breaks the build rather than quietly restoring a
 * hazard. Comments and runtime checks cannot do that: a runtime guard would only
 * fire on a path someone already took.
 *
 * Both holes were real on `d971d02` and are the reason this file exists:
 *
 *   - `linkArtifactVersion` still accepted a plain `Db`, so the claim that every
 *     mutating operation demanded the brand was false on the source.
 *   - `Tx` structurally extends `Db`, so `withTransaction(tx, ...)` compiled and
 *     recreated the nested BEGIN / inner COMMIT hazard the brand exists to
 *     prevent.
 */
import { describe, expect, it } from "vitest";
import {
  collectArtifactGarbage,
  linkArtifactVersion,
  publishArtifactVersion,
  putArtifact,
  retireArtifactVersion,
} from "../artifacts.js";
import { type Db, type Tx, withTransaction } from "../db.js";

const version = {
  tenant: "default",
  source: "confluence",
  nativeId: "att-1",
  revision: "1",
  digest: "d",
  docId: "confluence:page:a",
  mediaType: "application/pdf",
};

/**
 * Never invoked. Its only job is to be type-checked — calling it would hit a
 * database, and what is under test is the compiler's refusal, not behaviour.
 */
export async function _mutationsRequireATransaction(db: Db, tx: Tx): Promise<void> {
  // @ts-expect-error a plain Db cannot store bytes outside a transaction
  await putArtifact(db, "default", Buffer.from("x"), {});
  // @ts-expect-error a plain Db cannot record an observation outside a transaction
  await linkArtifactVersion(db, version);
  // @ts-expect-error a plain Db cannot publish outside a transaction
  await publishArtifactVersion(db, { ...version, bytes: Buffer.from("x") });
  // @ts-expect-error a plain Db cannot retire outside a transaction
  await retireArtifactVersion(db, version);
  // @ts-expect-error a plain Db cannot collect outside a transaction
  await collectArtifactGarbage(db, "default");

  // The same calls with a Tx must still compile — otherwise the assertions
  // above would pass for the trivial reason that nothing type-checks at all.
  await putArtifact(tx, "default", Buffer.from("x"), {});
  await linkArtifactVersion(tx, version);
  await publishArtifactVersion(tx, { ...version, bytes: Buffer.from("x") });
  await retireArtifactVersion(tx, version);
  await collectArtifactGarbage(tx, "default");
}

export async function _transactionsDoNotNest(db: Db, tx: Tx): Promise<void> {
  // A fresh connection may open one.
  await withTransaction(db, async () => undefined);

  // @ts-expect-error a connection already inside a transaction may not open another
  await withTransaction(tx, async () => undefined);

  // The composed shape this whole contract exists to enable: one boundary,
  // many operations. Must still compile.
  await withTransaction(db, async (t) => {
    await putArtifact(t, "default", Buffer.from("x"), {});
    await linkArtifactVersion(t, version);
  });
}

describe("the transaction contract is enforced by the compiler", () => {
  it("is proven by typecheck, not at runtime", () => {
    // The real assertions are the @ts-expect-error directives above, which fail
    // `tsc --noEmit` if the errors stop occurring. This case exists so the file
    // is a valid suite and so the reason is written down where a reader of the
    // test output will see it.
    expect(typeof _mutationsRequireATransaction).toBe("function");
    expect(typeof _transactionsDoNotNest).toBe("function");
  });
});
