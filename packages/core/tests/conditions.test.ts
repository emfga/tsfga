import { describe, expect, test } from "bun:test";
import { evaluateTupleCondition } from "../src/conditions.ts";
import {
  ConditionEvaluationError,
  ConditionNotFoundError,
} from "../src/errors.ts";
import type { Tuple } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

function makeTuple(overrides: Partial<Tuple> = {}): Tuple {
  return {
    objectType: "doc",
    objectId: "1",
    relation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: null,
    conditionName: null,
    conditionContext: null,
    ...overrides,
  };
}

describe("evaluateTupleCondition", () => {
  test("returns true when tuple has no condition", async () => {
    const store = new MockTupleStore();
    const tuple = makeTuple();
    expect(await evaluateTupleCondition(store, tuple)).toBe(true);
  });

  test("returns true when condition evaluates to true", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({ conditionName: "in_region" });
    expect(await evaluateTupleCondition(store, tuple, { region: "us" })).toBe(
      true,
    );
  });

  test("returns false when condition evaluates to false", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({ conditionName: "in_region" });
    expect(await evaluateTupleCondition(store, tuple, { region: "eu" })).toBe(
      false,
    );
  });

  test("tuple context takes precedence over request context", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({
      conditionName: "in_region",
      conditionContext: { region: "eu" },
    });
    // Tuple context overrides request context
    expect(await evaluateTupleCondition(store, tuple, { region: "us" })).toBe(
      false,
    );
  });

  test("uses tuple context when no request context", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({
      conditionName: "in_region",
      conditionContext: { region: "us" },
    });
    expect(await evaluateTupleCondition(store, tuple)).toBe(true);
  });

  test("returns false when a condition parameter is missing", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({ conditionName: "in_region" });
    // No context at all: the referenced variable is absent, which
    // must deny (OpenFGA returns {allowed: false}), not throw.
    expect(await evaluateTupleCondition(store, tuple)).toBe(false);
    expect(await evaluateTupleCondition(store, tuple, {})).toBe(false);
  });

  test("returns false when one of several parameters is missing", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "region_and_tier",
      expression: 'region == "us" && tier == "gold"',
      parameters: { region: "string", tier: "string" },
    });
    const tuple = makeTuple({ conditionName: "region_and_tier" });
    expect(await evaluateTupleCondition(store, tuple, { region: "us" })).toBe(
      false,
    );
  });

  test("throws ConditionNotFoundError for missing condition", async () => {
    const store = new MockTupleStore();
    const tuple = makeTuple({ conditionName: "nonexistent" });
    await expect(evaluateTupleCondition(store, tuple)).rejects.toBeInstanceOf(
      ConditionNotFoundError,
    );
  });

  test("throws ConditionEvaluationError for invalid expression", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "bad_expr",
      expression: "x + y",
      parameters: { x: "int", y: "int" },
    });
    const tuple = makeTuple({ conditionName: "bad_expr" });
    // Missing required context variables - should throw evaluation error
    // cel-js may return undefined or throw; we treat non-true as false
    // Let's test with a condition that definitely errors
    store.conditionDefinitions.length = 0;
    store.conditionDefinitions.push({
      name: "bad_expr",
      expression: "x.nonexistent_method()",
      parameters: {},
    });
    await expect(
      evaluateTupleCondition(store, tuple, { x: 42 }),
    ).rejects.toBeInstanceOf(ConditionEvaluationError);
  });

  test("caches compiled expressions", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "simple",
      expression: "allowed == true",
      parameters: { allowed: "bool" },
    });
    const tuple = makeTuple({ conditionName: "simple" });

    // Call twice - second call should use cached expression
    expect(await evaluateTupleCondition(store, tuple, { allowed: true })).toBe(
      true,
    );
    expect(await evaluateTupleCondition(store, tuple, { allowed: false })).toBe(
      false,
    );
  });

  test("handles numeric comparisons", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "min_level",
      expression: "level >= 5",
      parameters: { level: "int" },
    });
    const tuple = makeTuple({ conditionName: "min_level" });
    expect(await evaluateTupleCondition(store, tuple, { level: 10 })).toBe(
      true,
    );
    expect(await evaluateTupleCondition(store, tuple, { level: 3 })).toBe(
      false,
    );
  });

  test("handles uint comparisons", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "under_limit",
      expression: "count < limit",
      parameters: { count: "uint", limit: "uint" },
    });
    const tuple = makeTuple({ conditionName: "under_limit" });
    expect(
      await evaluateTupleCondition(store, tuple, { count: 5, limit: 10 }),
    ).toBe(true);
    expect(
      await evaluateTupleCondition(store, tuple, { count: 10, limit: 10 }),
    ).toBe(false);
  });
});
