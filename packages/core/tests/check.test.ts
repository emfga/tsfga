import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import {
  DepthExceededError,
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
  UsersetNotAllowedError,
} from "../src/errors.ts";
import { createTsfga } from "../src/index.ts";
import type { RelationConfig, Tuple } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

function makeTuple(overrides: Partial<Tuple> = {}): Tuple {
  return {
    objectType: "",
    objectId: "",
    relation: "",
    subjectType: "",
    subjectId: "",
    subjectRelation: null,
    conditionName: null,
    conditionContext: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RelationConfig> = {}): RelationConfig {
  return {
    objectType: "",
    relation: "",
    directlyAssignableTypes: null,
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    allowsUsersetSubjects: false,
    ...overrides,
  };
}

describe("check algorithm", () => {
  let store: MockTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
  });

  describe("Step 1: Direct tuple check", () => {
    test("returns true for direct tuple match", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(true);
    });

    test("returns false when no matching tuple", async () => {
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(false);
    });

    test("evaluates condition on direct tuple", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          conditionName: "in_region",
        }),
      );
      store.conditionDefinitions.push({
        name: "in_region",
        expression: 'region == "us"',
        parameters: { region: "string" },
      });

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          context: { region: "us" },
        }),
      ).toBe(true);

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          context: { region: "eu" },
        }),
      ).toBe(false);
    });
  });

  describe("Step 1b: Wildcard check", () => {
    test("returns true when wildcard tuple exists", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      );
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(true);
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "bob",
        }),
      ).toBe(true);
    });

    test("returns false when no wildcard tuple for the relation", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      );
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(false);
    });

    test("prefers direct tuple over wildcard", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      );
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(true);
    });

    test("evaluates condition on wildcard tuple", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
          conditionName: "in_region",
        }),
      );
      store.conditionDefinitions.push({
        name: "in_region",
        expression: 'region == "us"',
        parameters: { region: "string" },
      });

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          context: { region: "us" },
        }),
      ).toBe(true);

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          context: { region: "eu" },
        }),
      ).toBe(false);
    });
  });

  describe("Step 2: Userset expansion", () => {
    test("resolves userset tuple", async () => {
      // channel:proj#writer -> workspace:sandcastle#member
      store.tuples.push(
        makeTuple({
          objectType: "channel",
          objectId: "proj",
          relation: "writer",
          subjectType: "workspace",
          subjectId: "sandcastle",
          subjectRelation: "member",
        }),
      );
      // user:catherine is member of workspace:sandcastle
      store.tuples.push(
        makeTuple({
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "member",
          subjectType: "user",
          subjectId: "catherine",
        }),
      );

      expect(
        await check(store, {
          objectType: "channel",
          objectId: "proj",
          relation: "writer",
          subjectType: "user",
          subjectId: "catherine",
        }),
      ).toBe(true);
    });

    test("returns false when userset subject doesn't have relation", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "channel",
          objectId: "proj",
          relation: "writer",
          subjectType: "workspace",
          subjectId: "sandcastle",
          subjectRelation: "member",
        }),
      );
      // david is NOT a member of workspace:sandcastle (he's a guest)

      expect(
        await check(store, {
          objectType: "channel",
          objectId: "proj",
          relation: "writer",
          subjectType: "user",
          subjectId: "david",
        }),
      ).toBe(false);
    });

    test("evaluates condition on userset tuple", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "channel",
          objectId: "proj",
          relation: "writer",
          subjectType: "workspace",
          subjectId: "sandcastle",
          subjectRelation: "member",
          conditionName: "weekday_only",
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      store.conditionDefinitions.push({
        name: "weekday_only",
        expression: "is_weekday == true",
        parameters: { is_weekday: "bool" },
      });

      expect(
        await check(store, {
          objectType: "channel",
          objectId: "proj",
          relation: "writer",
          subjectType: "user",
          subjectId: "alice",
          context: { is_weekday: true },
        }),
      ).toBe(true);

      expect(
        await check(store, {
          objectType: "channel",
          objectId: "proj",
          relation: "writer",
          subjectType: "user",
          subjectId: "alice",
          context: { is_weekday: false },
        }),
      ).toBe(false);
    });
  });

  describe("Step 3: Relation inheritance (implied_by)", () => {
    test("resolves implied relation", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "workspace",
          relation: "member",
          impliedBy: ["channels_admin"],
        }),
      );
      store.relationConfigs.push(
        makeConfig({
          objectType: "workspace",
          relation: "channels_admin",
          impliedBy: ["legacy_admin"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "legacy_admin",
          subjectType: "user",
          subjectId: "amy",
        }),
      );

      // amy -> legacy_admin -> channels_admin -> member
      expect(
        await check(store, {
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "member",
          subjectType: "user",
          subjectId: "amy",
        }),
      ).toBe(true);
    });

    test("doesn't resolve unrelated implied chain", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "workspace",
          relation: "member",
          impliedBy: ["channels_admin"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "guest",
          subjectType: "user",
          subjectId: "david",
        }),
      );

      expect(
        await check(store, {
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "member",
          subjectType: "user",
          subjectId: "david",
        }),
      ).toBe(false);
    });
  });

  describe("Step 4: Computed userset", () => {
    test("checks computed userset relation on same object", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "branch",
          relation: "can_merge",
          computedUserset: "can_push",
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "branch",
          objectId: "main",
          relation: "can_push",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(
        await check(store, {
          objectType: "branch",
          objectId: "main",
          relation: "can_merge",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(true);
    });

    test("returns false when user doesn't have computed relation", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "branch",
          relation: "can_merge",
          computedUserset: "can_push",
        }),
      );

      expect(
        await check(store, {
          objectType: "branch",
          objectId: "main",
          relation: "can_merge",
          subjectType: "user",
          subjectId: "bob",
        }),
      ).toBe(false);
    });
  });

  describe("Step 5: Tuple-to-userset", () => {
    test("follows tupleset then checks computed userset", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "repo",
          relation: "reader",
          tupleToUserset: [
            {
              tupleset: "organization",
              computedUserset: "member",
            },
          ],
        }),
      );
      // repo:myrepo has organization -> org:acme
      store.tuples.push(
        makeTuple({
          objectType: "repo",
          objectId: "myrepo",
          relation: "organization",
          subjectType: "org",
          subjectId: "acme",
        }),
      );
      // user:alice is member of org:acme
      store.tuples.push(
        makeTuple({
          objectType: "org",
          objectId: "acme",
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(
        await check(store, {
          objectType: "repo",
          objectId: "myrepo",
          relation: "reader",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(true);
    });

    test("returns false when user doesn't have relation on linked object", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "repo",
          relation: "reader",
          tupleToUserset: [
            {
              tupleset: "organization",
              computedUserset: "member",
            },
          ],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "repo",
          objectId: "myrepo",
          relation: "organization",
          subjectType: "org",
          subjectId: "acme",
        }),
      );
      // bob is NOT a member of org:acme

      expect(
        await check(store, {
          objectType: "repo",
          objectId: "myrepo",
          relation: "reader",
          subjectType: "user",
          subjectId: "bob",
        }),
      ).toBe(false);
    });
  });

  describe("Exclusion (but not)", () => {
    test("denies access when user has excluded relation", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "editor",
          directlyAssignableTypes: ["user"],
          excludedBy: "blocked",
        }),
        makeConfig({
          objectType: "doc",
          relation: "blocked",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "carl",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "blocked",
          subjectType: "user",
          subjectId: "carl",
        }),
      );

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "carl",
        }),
      ).toBe(false);
    });

    test("allows access when user does NOT have excluded relation", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "editor",
          directlyAssignableTypes: ["user"],
          excludedBy: "blocked",
        }),
        makeConfig({
          objectType: "doc",
          relation: "blocked",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "becky",
        }),
      );

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "becky",
        }),
      ).toBe(true);
    });
  });

  describe("Intersection (and)", () => {
    test("grants access when all operands are true", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "can_delete",
          intersection: [
            { type: "computedUserset", relation: "writer" },
            {
              type: "tupleToUserset",
              tupleset: "owner",
              computedUserset: "member",
            },
          ],
        }),
        makeConfig({
          objectType: "doc",
          relation: "writer",
          directlyAssignableTypes: ["user"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "owner",
          directlyAssignableTypes: ["org"],
        }),
        makeConfig({
          objectType: "org",
          relation: "member",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "writer",
          subjectType: "user",
          subjectId: "alice",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "owner",
          subjectType: "org",
          subjectId: "acme",
        }),
        makeTuple({
          objectType: "org",
          objectId: "acme",
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "can_delete",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(true);
    });

    test("denies access when one operand is false", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "can_delete",
          intersection: [
            { type: "computedUserset", relation: "writer" },
            {
              type: "tupleToUserset",
              tupleset: "owner",
              computedUserset: "member",
            },
          ],
        }),
        makeConfig({
          objectType: "doc",
          relation: "writer",
          directlyAssignableTypes: ["user"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "owner",
          directlyAssignableTypes: ["org"],
        }),
        makeConfig({
          objectType: "org",
          relation: "member",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "writer",
          subjectType: "user",
          subjectId: "bob",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "owner",
          subjectType: "org",
          subjectId: "acme",
        }),
        // bob is NOT a member of org:acme
      );

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "can_delete",
          subjectType: "user",
          subjectId: "bob",
        }),
      ).toBe(false);
    });
  });

  describe("Contextual tuples", () => {
    beforeEach(() => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user", "team"],
          allowsUsersetSubjects: true,
        }),
        makeConfig({
          objectType: "doc",
          relation: "editor",
          directlyAssignableTypes: ["user"],
        }),
      );
    });

    test("finds direct match from contextual tuple", async () => {
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          contextualTuples: [
            {
              objectType: "doc",
              objectId: "1",
              relation: "viewer",
              subjectType: "user",
              subjectId: "alice",
            },
          ],
        }),
      ).toBe(true);
    });

    test("finds userset from contextual tuple", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "team",
          relation: "member",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "team",
          subjectId: "writers",
          subjectRelation: "member",
        }),
      );

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          contextualTuples: [
            {
              objectType: "team",
              objectId: "writers",
              relation: "member",
              subjectType: "user",
              subjectId: "alice",
            },
          ],
        }),
      ).toBe(true);
    });

    test("returns false when contextual tuple does not match", async () => {
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          contextualTuples: [
            {
              objectType: "doc",
              objectId: "1",
              relation: "editor",
              subjectType: "user",
              subjectId: "alice",
            },
          ],
        }),
      ).toBe(false);
    });
  });

  describe("Max depth protection", () => {
    /**
     * Build a computedUserset chain lvl0 -> lvl1 -> ... -> lvlN
     * with a direct tuple at lvlN. Resolving lvl0 requires N
     * recursion steps.
     */
    function buildChain(length: number) {
      for (let i = 0; i < length; i++) {
        store.relationConfigs.push(
          makeConfig({
            objectType: "doc",
            relation: `lvl${i}`,
            computedUserset: `lvl${i + 1}`,
          }),
        );
      }
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: `lvl${length}`,
          subjectType: "user",
          subjectId: "alice",
        }),
      );
    }

    test("resolves when chain depth is exactly at the limit", async () => {
      buildChain(3);
      expect(
        await check(
          store,
          {
            objectType: "doc",
            objectId: "1",
            relation: "lvl0",
            subjectType: "user",
            subjectId: "alice",
          },
          { maxDepth: 3 },
        ),
      ).toBe(true);
    });

    test("throws DepthExceededError beyond the limit", async () => {
      buildChain(3);
      await expect(
        check(
          store,
          {
            objectType: "doc",
            objectId: "1",
            relation: "lvl0",
            subjectType: "user",
            subjectId: "alice",
          },
          { maxDepth: 2 },
        ),
      ).rejects.toBeInstanceOf(DepthExceededError);
    });
  });

  describe("Cycle detection", () => {
    test("throws DepthExceededError on cyclic implied_by", async () => {
      store.relationConfigs.push(
        makeConfig({ objectType: "doc", relation: "a", impliedBy: ["b"] }),
        makeConfig({ objectType: "doc", relation: "b", impliedBy: ["a"] }),
      );

      await expect(
        check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "a",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).rejects.toBeInstanceOf(DepthExceededError);
    });

    test("true branch wins over a cyclic sibling branch", async () => {
      // member is implied by both a cyclic relation and admin;
      // the cyclic branch throws but the admin branch grants.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "member",
          impliedBy: ["looper", "admin"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "looper",
          impliedBy: ["member"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "admin",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "admin",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(true);
    });

    test("propagates error when no sibling branch grants", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "member",
          impliedBy: ["looper", "admin"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "looper",
          impliedBy: ["member"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "admin",
          directlyAssignableTypes: ["user"],
        }),
      );
      // alice has no admin tuple: the cyclic branch's error must
      // surface instead of resolving false.
      await expect(
        check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).rejects.toBeInstanceOf(DepthExceededError);
    });
  });

  describe("Exclusion fails closed on depth exhaustion", () => {
    test("cyclic exclusion branch throws instead of granting", async () => {
      // carl has a direct editor tuple, but the excludedBy relation
      // cannot be resolved (cyclic). Pre-0.3.0 this failed open:
      // the truncated exclusion read as "not excluded" and granted.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "editor",
          directlyAssignableTypes: ["user"],
          excludedBy: "banned",
        }),
        makeConfig({
          objectType: "doc",
          relation: "banned",
          impliedBy: ["banned_loop"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "banned_loop",
          impliedBy: ["banned"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "carl",
        }),
      );

      await expect(
        check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "carl",
        }),
      ).rejects.toBeInstanceOf(DepthExceededError);
    });

    test("deep exclusion branch throws instead of granting", async () => {
      // The exclusion chain needs more depth than maxDepth allows.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "editor",
          directlyAssignableTypes: ["user"],
          excludedBy: "b0",
        }),
      );
      for (let i = 0; i < 5; i++) {
        store.relationConfigs.push(
          makeConfig({
            objectType: "doc",
            relation: `b${i}`,
            computedUserset: `b${i + 1}`,
          }),
        );
      }
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "carl",
        }),
      );

      await expect(
        check(
          store,
          {
            objectType: "doc",
            objectId: "1",
            relation: "editor",
            subjectType: "user",
            subjectId: "carl",
          },
          { maxDepth: 3 },
        ),
      ).rejects.toBeInstanceOf(DepthExceededError);
    });

    test("base false denies even when exclusion branch errors", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "editor",
          directlyAssignableTypes: ["user"],
          excludedBy: "banned",
        }),
        makeConfig({
          objectType: "doc",
          relation: "banned",
          impliedBy: ["banned"],
        }),
      );
      // No editor tuple: definite deny regardless of exclusion.
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "carl",
        }),
      ).toBe(false);
    });
  });

  describe("Multi-entry tuple-to-userset", () => {
    beforeEach(() => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "project",
          relation: "editor",
          tupleToUserset: [
            { tupleset: "owner", computedUserset: "project_editor" },
            { tupleset: "partner", computedUserset: "project_editor" },
          ],
        }),
      );
    });

    test("grants via the first TTU entry", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "project",
          objectId: "p1",
          relation: "owner",
          subjectType: "org",
          subjectId: "acme",
        }),
        makeTuple({
          objectType: "org",
          objectId: "acme",
          relation: "project_editor",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      expect(
        await check(store, {
          objectType: "project",
          objectId: "p1",
          relation: "editor",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(true);
    });

    test("grants via the second TTU entry", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "project",
          objectId: "p1",
          relation: "partner",
          subjectType: "org",
          subjectId: "globex",
        }),
        makeTuple({
          objectType: "org",
          objectId: "globex",
          relation: "project_editor",
          subjectType: "user",
          subjectId: "bob",
        }),
      );
      expect(
        await check(store, {
          objectType: "project",
          objectId: "p1",
          relation: "editor",
          subjectType: "user",
          subjectId: "bob",
        }),
      ).toBe(true);
    });

    test("denies when neither entry grants", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "project",
          objectId: "p1",
          relation: "owner",
          subjectType: "org",
          subjectId: "acme",
        }),
      );
      expect(
        await check(store, {
          objectType: "project",
          objectId: "p1",
          relation: "editor",
          subjectType: "user",
          subjectId: "mallory",
        }),
      ).toBe(false);
    });
  });

  describe("Intersection with direct operand", () => {
    beforeEach(() => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "publish",
          directlyAssignableTypes: ["user"],
          intersection: [
            { type: "direct" },
            { type: "computedUserset", relation: "approved" },
          ],
        }),
        makeConfig({
          objectType: "doc",
          relation: "approved",
          directlyAssignableTypes: ["user"],
        }),
      );
    });

    test("grants when direct tuple and other operand hold", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "publish",
          subjectType: "user",
          subjectId: "alice",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "approved",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "publish",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(true);
    });

    test("denies when direct operand is missing", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "approved",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "publish",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(false);
    });

    test("denies when the other operand is missing", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "publish",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "publish",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(false);
    });
  });

  describe("Intersection combined with exclusion", () => {
    test("excludedBy applies on top of intersection result", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "publish",
          directlyAssignableTypes: ["user"],
          intersection: [
            { type: "direct" },
            { type: "computedUserset", relation: "approved" },
          ],
          excludedBy: "banned",
        }),
        makeConfig({
          objectType: "doc",
          relation: "approved",
          directlyAssignableTypes: ["user"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "banned",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "publish",
          subjectType: "user",
          subjectId: "alice",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "approved",
          subjectType: "user",
          subjectId: "alice",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "banned",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      // Intersection is satisfied, but alice is banned.
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "publish",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(false);

      // bob satisfies the intersection and is not banned.
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "publish",
          subjectType: "user",
          subjectId: "bob",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "approved",
          subjectType: "user",
          subjectId: "bob",
        }),
      );
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "publish",
          subjectType: "user",
          subjectId: "bob",
        }),
      ).toBe(true);
    });
  });

  describe("Contextual tuple validation", () => {
    test("throws when relation config is missing", async () => {
      await expect(
        check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          contextualTuples: [
            {
              objectType: "doc",
              objectId: "1",
              relation: "viewer",
              subjectType: "user",
              subjectId: "alice",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(RelationConfigNotFoundError);
    });

    test("throws for a disallowed subject type", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user"],
        }),
      );
      await expect(
        check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          contextualTuples: [
            {
              objectType: "doc",
              objectId: "1",
              relation: "viewer",
              subjectType: "robot",
              subjectId: "r2d2",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
    });

    test("throws for a wildcard subject when type:* not allowed", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user"],
        }),
      );
      await expect(
        check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "bob",
          contextualTuples: [
            {
              objectType: "doc",
              objectId: "1",
              relation: "viewer",
              subjectType: "user",
              subjectId: "*",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
    });

    test("accepts a wildcard subject when type:* is allowed", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user", "user:*"],
        }),
      );
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "bob",
          contextualTuples: [
            {
              objectType: "doc",
              objectId: "1",
              relation: "viewer",
              subjectType: "user",
              subjectId: "*",
            },
          ],
        }),
      ).toBe(true);
    });

    test("throws for a userset subject when not allowed", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user", "team"],
          allowsUsersetSubjects: false,
        }),
      );
      await expect(
        check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          contextualTuples: [
            {
              objectType: "doc",
              objectId: "1",
              relation: "viewer",
              subjectType: "team",
              subjectId: "writers",
              subjectRelation: "member",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(UsersetNotAllowedError);
    });
  });

  describe("Slack model (combined steps)", () => {
    beforeEach(() => {
      // Relation configs
      store.relationConfigs.push(
        makeConfig({
          objectType: "workspace",
          relation: "legacy_admin",
          directlyAssignableTypes: ["user"],
        }),
        makeConfig({
          objectType: "workspace",
          relation: "channels_admin",
          directlyAssignableTypes: ["user"],
          impliedBy: ["legacy_admin"],
        }),
        makeConfig({
          objectType: "workspace",
          relation: "member",
          directlyAssignableTypes: ["user"],
          impliedBy: ["channels_admin"],
        }),
        makeConfig({
          objectType: "workspace",
          relation: "guest",
          directlyAssignableTypes: ["user"],
        }),
        makeConfig({
          objectType: "channel",
          relation: "writer",
          directlyAssignableTypes: ["user", "workspace"],
          allowsUsersetSubjects: true,
        }),
        makeConfig({
          objectType: "channel",
          relation: "commenter",
          directlyAssignableTypes: ["user", "workspace"],
          impliedBy: ["writer"],
          allowsUsersetSubjects: true,
        }),
      );

      // Tuples
      store.tuples.push(
        // Workspace roles
        makeTuple({
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "legacy_admin",
          subjectType: "user",
          subjectId: "amy",
        }),
        makeTuple({
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "channels_admin",
          subjectType: "user",
          subjectId: "bob",
        }),
        makeTuple({
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "member",
          subjectType: "user",
          subjectId: "catherine",
        }),
        makeTuple({
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "guest",
          subjectType: "user",
          subjectId: "david",
        }),
        makeTuple({
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "member",
          subjectType: "user",
          subjectId: "emily",
        }),
        // Channel: general
        makeTuple({
          objectType: "channel",
          objectId: "general",
          relation: "writer",
          subjectType: "user",
          subjectId: "emily",
        }),
        // Channel: marketing_internal
        makeTuple({
          objectType: "channel",
          objectId: "marketing_internal",
          relation: "writer",
          subjectType: "user",
          subjectId: "bob",
        }),
        makeTuple({
          objectType: "channel",
          objectId: "marketing_internal",
          relation: "writer",
          subjectType: "user",
          subjectId: "emily",
        }),
        // Channel: proj_marketing_campaign
        makeTuple({
          objectType: "channel",
          objectId: "proj_marketing_campaign",
          relation: "writer",
          subjectType: "user",
          subjectId: "david",
        }),
        makeTuple({
          objectType: "channel",
          objectId: "proj_marketing_campaign",
          relation: "writer",
          subjectType: "user",
          subjectId: "emily",
        }),
        // Userset: workspace:sandcastle#member -> channel:proj_marketing_campaign#writer
        makeTuple({
          objectType: "channel",
          objectId: "proj_marketing_campaign",
          relation: "writer",
          subjectType: "workspace",
          subjectId: "sandcastle",
          subjectRelation: "member",
        }),
      );
    });

    // Test 1: amy is legacy_admin
    test("amy is legacy_admin of workspace:sandcastle", async () => {
      expect(
        await check(store, {
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "legacy_admin",
          subjectType: "user",
          subjectId: "amy",
        }),
      ).toBe(true);
    });

    // Test 2: amy is member via legacy_admin -> channels_admin -> member
    test("amy is member via inheritance chain", async () => {
      expect(
        await check(store, {
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "member",
          subjectType: "user",
          subjectId: "amy",
        }),
      ).toBe(true);
    });

    // Test 3: bob is channels_admin
    test("bob is channels_admin", async () => {
      expect(
        await check(store, {
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "channels_admin",
          subjectType: "user",
          subjectId: "bob",
        }),
      ).toBe(true);
    });

    // Test 4: bob is member via channels_admin -> member
    test("bob is member via channels_admin", async () => {
      expect(
        await check(store, {
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "member",
          subjectType: "user",
          subjectId: "bob",
        }),
      ).toBe(true);
    });

    // Test 5: catherine is direct member
    test("catherine is direct member", async () => {
      expect(
        await check(store, {
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "member",
          subjectType: "user",
          subjectId: "catherine",
        }),
      ).toBe(true);
    });

    // Test 6: david is NOT member
    test("david is NOT member", async () => {
      expect(
        await check(store, {
          objectType: "workspace",
          objectId: "sandcastle",
          relation: "member",
          subjectType: "user",
          subjectId: "david",
        }),
      ).toBe(false);
    });

    // Test 7: emily is writer on #general
    test("emily is writer on #general", async () => {
      expect(
        await check(store, {
          objectType: "channel",
          objectId: "general",
          relation: "writer",
          subjectType: "user",
          subjectId: "emily",
        }),
      ).toBe(true);
    });

    // Test 8: david is NOT writer on #general
    test("david is NOT writer on #general", async () => {
      expect(
        await check(store, {
          objectType: "channel",
          objectId: "general",
          relation: "writer",
          subjectType: "user",
          subjectId: "david",
        }),
      ).toBe(false);
    });

    // Test 9: catherine writes proj_marketing_campaign via userset
    test("catherine is writer on proj_marketing_campaign via workspace#member", async () => {
      expect(
        await check(store, {
          objectType: "channel",
          objectId: "proj_marketing_campaign",
          relation: "writer",
          subjectType: "user",
          subjectId: "catherine",
        }),
      ).toBe(true);
    });

    // Test 10: amy writes proj_marketing_campaign via inheritance + userset
    test("amy is writer on proj_marketing_campaign via inheritance + userset", async () => {
      expect(
        await check(store, {
          objectType: "channel",
          objectId: "proj_marketing_campaign",
          relation: "writer",
          subjectType: "user",
          subjectId: "amy",
        }),
      ).toBe(true);
    });

    // Test 11: david writes proj_marketing_campaign (direct, despite being guest)
    test("david is writer on proj_marketing_campaign (direct)", async () => {
      expect(
        await check(store, {
          objectType: "channel",
          objectId: "proj_marketing_campaign",
          relation: "writer",
          subjectType: "user",
          subjectId: "david",
        }),
      ).toBe(true);
    });

    // Test 12: emily is commenter on #general (writer implies commenter)
    test("emily is commenter on #general via writer inheritance", async () => {
      expect(
        await check(store, {
          objectType: "channel",
          objectId: "general",
          relation: "commenter",
          subjectType: "user",
          subjectId: "emily",
        }),
      ).toBe(true);
    });
  });
});

describe("createTsfga client", () => {
  let store: MockTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
  });

  describe("addTuple validation", () => {
    test("throws RelationConfigNotFoundError without config", async () => {
      const fga = createTsfga(store);
      await expect(
        fga.addTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).rejects.toBeInstanceOf(RelationConfigNotFoundError);
    });

    test("throws InvalidSubjectTypeError for wrong type", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user"],
        }),
      );
      const fga = createTsfga(store);
      await expect(
        fga.addTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "robot",
          subjectId: "r2d2",
        }),
      ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
    });

    test("throws for wildcard subject when type:* not allowed", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user"],
        }),
      );
      const fga = createTsfga(store);
      await expect(
        fga.addTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
    });

    test("accepts wildcard subject when type:* is allowed", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user", "user:*"],
        }),
      );
      const fga = createTsfga(store);
      await fga.addTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "*",
      });
      expect(store.tuples).toHaveLength(1);
    });

    test("throws UsersetNotAllowedError when forbidden", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user", "team"],
          allowsUsersetSubjects: false,
        }),
      );
      const fga = createTsfga(store);
      await expect(
        fga.addTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "team",
          subjectId: "writers",
          subjectRelation: "member",
        }),
      ).rejects.toBeInstanceOf(UsersetNotAllowedError);
    });
  });

  describe("listObjects", () => {
    beforeEach(() => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "2",
          relation: "viewer",
          subjectType: "user",
          subjectId: "bob",
        }),
      );
    });

    test("returns only objects the subject can access", async () => {
      const fga = createTsfga(store);
      expect(await fga.listObjects("doc", "viewer", "user", "alice")).toEqual([
        "1",
      ]);
    });

    test("propagates context to per-object checks", async () => {
      store.conditionDefinitions.push({
        name: "in_region",
        expression: 'region == "us"',
        parameters: { region: "string" },
      });
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "3",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          conditionName: "in_region",
        }),
      );
      const fga = createTsfga(store);
      expect(
        await fga.listObjects("doc", "viewer", "user", "alice", {
          region: "us",
        }),
      ).toEqual(["1", "3"]);
      expect(
        await fga.listObjects("doc", "viewer", "user", "alice", {
          region: "eu",
        }),
      ).toEqual(["1"]);
    });
  });

  describe("listSubjects", () => {
    test("returns direct subjects for object + relation", async () => {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "team",
          subjectId: "writers",
          subjectRelation: "member",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "2",
          relation: "viewer",
          subjectType: "user",
          subjectId: "bob",
        }),
      );
      const fga = createTsfga(store);
      const subjects = await fga.listSubjects("doc", "1", "viewer");
      expect(subjects).toEqual([
        { subjectType: "user", subjectId: "alice", subjectRelation: null },
        {
          subjectType: "team",
          subjectId: "writers",
          subjectRelation: "member",
        },
      ]);
    });
  });

  describe("maxDepth option", () => {
    test("client-level maxDepth applies to checks", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "a",
          computedUserset: "b",
        }),
        makeConfig({
          objectType: "doc",
          relation: "b",
          computedUserset: "c",
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "c",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      const shallow = createTsfga(store, { maxDepth: 1 });
      await expect(
        shallow.check({
          objectType: "doc",
          objectId: "1",
          relation: "a",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).rejects.toBeInstanceOf(DepthExceededError);

      const deep = createTsfga(store, { maxDepth: 2 });
      expect(
        await deep.check({
          objectType: "doc",
          objectId: "1",
          relation: "a",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(true);
    });
  });
});
