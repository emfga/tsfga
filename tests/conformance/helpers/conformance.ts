import { expect } from "bun:test";
import type { AddTupleRequest, CheckRequest, TsfgaClient } from "@tsfga/core";
import { fgaCheck, fgaWrite } from "./openfga.ts";

/**
 * Assert that tsfga and OpenFGA return the same result for a permission check.
 * Runs both checks in parallel for speed.
 */
export async function expectConformance(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  params: CheckRequest,
  expected: boolean,
): Promise<void> {
  const contextualTuples = params.contextualTuples?.map((t) => ({
    user: t.subjectRelation
      ? `${t.subjectType}:${t.subjectId}#${t.subjectRelation}`
      : `${t.subjectType}:${t.subjectId}`,
    relation: t.relation,
    object: `${t.objectType}:${t.objectId}`,
  }));

  const [tsfgaResult, openFgaResult] = await Promise.all([
    tsfgaClient.check(params),
    fgaCheck(storeId, authorizationModelId, {
      objectType: params.objectType,
      objectId: params.objectId,
      relation: params.relation,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      context: params.context,
      contextualTuples,
    }),
  ]);

  if (openFgaResult === null) {
    throw new Error("OpenFGA returned an error");
  }

  // Both systems must agree
  expect(tsfgaResult).toBe(openFgaResult);
  // And match expected value
  expect(tsfgaResult).toBe(expected);
}

/**
 * Assert that tsfga and OpenFGA agree on whether a tuple may be
 * *written* at all.
 *
 * Type restrictions are enforced twice by OpenFGA — once when the
 * tuple is written, once when a check reads it — and the two must
 * be checked separately. A suite that only ever writes through the
 * validating path cannot observe a read-gate divergence, because
 * the rows that would expose it are the rows the write path
 * refuses to create.
 *
 * `expected` is what both systems must do, so a test that asserts
 * a *legal* write also fails if either side wrongly refuses it.
 */
export async function expectWriteConformance(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  tuple: AddTupleRequest,
  expected: "accepted" | "refused",
): Promise<void> {
  const [tsfgaOutcome, openFgaOutcome] = await Promise.all([
    tsfgaClient
      .addTuple(tuple)
      .then(() => "accepted" as const)
      .catch(() => "refused" as const),
    fgaWrite(storeId, authorizationModelId, tuple),
  ]);

  expect(tsfgaOutcome).toBe(openFgaOutcome);
  expect(tsfgaOutcome).toBe(expected);
}
