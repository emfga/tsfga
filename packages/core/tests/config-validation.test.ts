import { beforeEach, describe, expect, test } from "bun:test";
import {
  ImplicitTupleError,
  InvalidRelationConfigError,
} from "../src/errors.ts";
import { createTsfga, type TsfgaClient } from "../src/index.ts";
import type { RelationConfig } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

/**
 * The write gates for shapes OpenFGA's typesystem refuses.
 *
 * Pinned two-sided in
 * `tests/conformance/config-validation.test.ts`. Here the same
 * rules are exercised against the mock, plus the two things the
 * conformance suite cannot say: the error class each refusal
 * raises, and that the self-reference gate is on `addTuple` and
 * **not** on the shared validation contextual tuples run.
 */

function config(overrides: Partial<RelationConfig>): RelationConfig {
  return {
    objectType: "doc",
    relation: "viewer",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

describe("writeRelationConfig refuses what the model would", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    fga = createTsfga(store);
  });

  test("an intersection with one operand", async () => {
    await expect(
      fga.writeRelationConfig(
        config({ intersection: [{ type: "computedUserset", relation: "a" }] }),
      ),
    ).rejects.toBeInstanceOf(InvalidRelationConfigError);
  });

  test("an intersection with no operands", async () => {
    await expect(
      fga.writeRelationConfig(config({ intersection: [] })),
    ).rejects.toBeInstanceOf(InvalidRelationConfigError);
  });

  test("the control: two operands are accepted", async () => {
    await expect(
      fga.writeRelationConfig(
        config({
          intersection: [
            { type: "computedUserset", relation: "a" },
            { type: "computedUserset", relation: "b" },
          ],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  test("a restriction naming an undefined condition", async () => {
    await expect(
      fga.writeRelationConfig(
        config({ directlyAssignable: [{ type: "user", condition: "nope" }] }),
      ),
    ).rejects.toBeInstanceOf(InvalidRelationConfigError);
  });

  test("the control: a defined condition is accepted", async () => {
    await fga.writeConditionDefinition({
      name: "yep",
      expression: "true",
      parameters: {},
    });
    await expect(
      fga.writeRelationConfig(
        config({ directlyAssignable: [{ type: "user", condition: "yep" }] }),
      ),
    ).resolves.toBeUndefined();
  });

  describe("a tupleset relation that admits too much", () => {
    /** The tupleset relation is written first, or there is nothing
     * to read — see the stated gap below. */
    async function writeParent(
      directlyAssignable: RelationConfig["directlyAssignable"],
    ): Promise<void> {
      await fga.writeRelationConfig(
        config({ relation: "parent", directlyAssignable }),
      );
    }

    const ttu = config({
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    });

    test("a userset ref", async () => {
      await writeParent([{ type: "folder", relation: "owner" }]);
      await expect(fga.writeRelationConfig(ttu)).rejects.toBeInstanceOf(
        InvalidRelationConfigError,
      );
    });

    test("a wildcard ref", async () => {
      await writeParent([{ type: "folder", wildcard: true }]);
      await expect(fga.writeRelationConfig(ttu)).rejects.toBeInstanceOf(
        InvalidRelationConfigError,
      );
    });

    test("the control: a bare type is accepted", async () => {
      await writeParent([{ type: "folder" }]);
      await expect(fga.writeRelationConfig(ttu)).resolves.toBeUndefined();
    });

    test("an intersection operand's tupleset is checked too", async () => {
      // The operand form is the one a fix applied to step 5 alone
      // would leave open, and it is the worse of the two: inside
      // the subtrahend of an exclusion it grants rather than denies.
      await writeParent([{ type: "folder", relation: "owner" }]);
      await expect(
        fga.writeRelationConfig(
          config({
            intersection: [
              { type: "computedUserset", relation: "a" },
              {
                type: "tupleToUserset",
                tupleset: "parent",
                computedUserset: "viewer",
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidRelationConfigError);
    });

    test("the stated gap: no config to read, no check", async () => {
      // Declared before its tupleset relation exists. Accepted,
      // deliberately: closing this needs a reverse lookup TupleStore
      // has not got, and a validator that fired on write order would
      // refuse correct models for arriving in an undocumented order.
      await expect(fga.writeRelationConfig(ttu)).resolves.toBeUndefined();
      await expect(
        writeParent([{ type: "folder", relation: "owner" }]),
      ).resolves.toBeUndefined();
    });
  });
});

describe("addTuple refuses a tuple that is implicit", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(async () => {
    store = new MockTupleStore();
    fga = createTsfga(store);
    await fga.writeRelationConfig(
      config({
        relation: "blocked",
        directlyAssignable: [
          { type: "user" },
          { type: "doc", relation: "blocked" },
        ],
      }),
    );
  });

  const selfTuple = {
    objectType: "doc",
    objectId: "1",
    relation: "blocked",
    subjectType: "doc",
    subjectId: "1",
    subjectRelation: "blocked",
  };

  test("the write is refused", async () => {
    await expect(fga.addTuple(selfTuple)).rejects.toBeInstanceOf(
      ImplicitTupleError,
    );
  });

  test("a different object of the same relation is accepted", async () => {
    await expect(
      fga.addTuple({ ...selfTuple, subjectId: "2" }),
    ).resolves.toBeUndefined();
  });

  test("a different relation on the same object is accepted", async () => {
    await fga.writeRelationConfig(
      config({
        relation: "member",
        directlyAssignable: [{ type: "doc", relation: "blocked" }],
      }),
    );
    await expect(
      fga.addTuple({ ...selfTuple, relation: "member" }),
    ).resolves.toBeUndefined();
  });

  /**
   * The asymmetry, and the reason the gate is not in
   * `validateTupleWrite`. Upstream refuses the write and accepts
   * the same tuple contextually — measured on v1.18.2 with a
   * control proving the contextual field was honoured — so sharing
   * the gate would refuse a tuple OpenFGA takes.
   */
  test("the same tuple is accepted contextually", async () => {
    store.tuples.push({
      objectType: "doc",
      objectId: "1",
      relation: "blocked",
      subjectType: "user",
      subjectId: "alice",
      subjectRelation: null,
      conditionName: null,
      conditionContext: null,
    });
    expect(
      await fga.check({
        objectType: "doc",
        objectId: "1",
        relation: "blocked",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [selfTuple],
      }),
    ).toBe(true);
  });
});
