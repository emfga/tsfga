import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import { ContextualTupleStore } from "../src/contextual-store.ts";
import {
  DepthExceededError,
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
} from "../src/errors.ts";
import { createTsfga } from "../src/index.ts";
import type { RelationConfig, Tuple } from "../src/types.ts";
import {
  ConfigErrorStore,
  StoreReadFailure,
} from "./helpers/erroring-store.ts";
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
    directlyAssignable: [
      { type: "user" },
      { type: "user", wildcard: true },
      { type: "robot" },
      { type: "robot", wildcard: true },
      { type: "team" },
      { type: "team", wildcard: true },
      { type: "group" },
      { type: "group", wildcard: true },
      { type: "org" },
      { type: "org", wildcard: true },
      { type: "workspace" },
      { type: "workspace", wildcard: true },
      { type: "blocklist" },
      { type: "blocklist", wildcard: true },
      // `#member` is the only userset relation this file assigns,
      // and a relation admits a userset ref only by naming it.
      { type: "team", relation: "member" },
      { type: "group", relation: "member" },
      { type: "org", relation: "member" },
      { type: "workspace", relation: "member" },
      { type: "blocklist", relation: "member" },
    ],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

/**
 * Declare the relations a fixture's rows live on, as
 * `objectType.relation`.
 *
 * `check` refuses a relation the model does not define, so a
 * fixture has to state its model even where the test is about
 * something else. These configs are as wide as `makeConfig`'s
 * default list, which is what the fixtures assumed implicitly
 * while a missing config read as unrestricted.
 */
function declareRelations(store: MockTupleStore, ...names: string[]): void {
  for (const name of names) {
    const [objectType, relation] = name.split(".");
    store.relationConfigs.push(
      makeConfig({ objectType: objectType ?? "", relation: relation ?? "" }),
    );
  }
}

/**
 * Define the types a fixture names as subjects, without declaring
 * the relation the test is about.
 *
 * A type is defined by the restrictions that name it, so a fixture
 * with no relation config at all — or one whose restrictions name
 * only other types — defines no `user` either, and `check` now
 * refuses the *subject* before reaching the gate under test. That
 * ordering is upstream's: `ValidateUser` runs ahead of
 * `ValidateObject` and `ValidateRelation`
 * (`internal/validation/validation.go:18-32`). One config on a type
 * nothing else mentions carries `makeConfig`'s whole restriction
 * list and puts every subject type back, without adding a relation
 * to the model under test.
 */
function declareSubjectTypes(store: MockTupleStore): void {
  store.relationConfigs.push(
    makeConfig({ objectType: "subject_types", relation: "declared" }),
  );
}

describe("check algorithm", () => {
  let store: MockTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
  });

  describe("Step 1: Direct tuple check", () => {
    test("returns true for direct tuple match", async () => {
      declareRelations(store, "doc.viewer");
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
      declareRelations(store, "doc.viewer");
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
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignable: [{ type: "user", condition: "in_region" }],
        }),
      );
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
      declareRelations(store, "doc.viewer");
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
      declareRelations(store, "doc.viewer", "doc.editor");
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
      declareRelations(store, "doc.viewer");
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
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignable: [
            { type: "user", wildcard: true, condition: "in_region" },
          ],
        }),
      );
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
      declareRelations(store, "channel.writer", "workspace.member");
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
      declareRelations(store, "channel.writer", "workspace.member");
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
      store.relationConfigs.push(
        makeConfig({
          objectType: "channel",
          relation: "writer",
          directlyAssignable: [
            {
              type: "workspace",
              relation: "member",
              condition: "weekday_only",
            },
          ],
        }),
      );
      declareRelations(store, "workspace.member");
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
      declareRelations(store, "workspace.legacy_admin");
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
      declareRelations(store, "workspace.channels_admin", "workspace.guest");
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
      declareRelations(store, "branch.can_push");
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
      declareRelations(store, "branch.can_push");
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
      declareRelations(store, "repo.organization", "org.member");
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
      declareRelations(store, "repo.organization", "org.member");
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
          directlyAssignable: [{ type: "user" }],
          excludedBy: "blocked",
        }),
        makeConfig({
          objectType: "doc",
          relation: "blocked",
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [{ type: "user" }],
          excludedBy: "blocked",
        }),
        makeConfig({
          objectType: "doc",
          relation: "blocked",
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [{ type: "user" }],
        }),
        makeConfig({
          objectType: "doc",
          relation: "owner",
          directlyAssignable: [{ type: "org" }],
        }),
        makeConfig({
          objectType: "org",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [{ type: "user" }],
        }),
        makeConfig({
          objectType: "doc",
          relation: "owner",
          directlyAssignable: [{ type: "org" }],
        }),
        makeConfig({
          objectType: "org",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [
            { type: "user" },
            { type: "team" },
            { type: "team", relation: "member" },
            { type: "group", relation: "member" },
            { type: "org", relation: "member" },
            { type: "workspace", relation: "member" },
            { type: "blocklist", relation: "member" },
          ],
        }),
        makeConfig({
          objectType: "doc",
          relation: "editor",
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [{ type: "user" }],
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

    /**
     * The overlay is asymmetric and has to stay that way. A probe
     * returns one tuple, so a contextual tuple on that key
     * *replaces* the stored one; the userset scan returns a set,
     * so there the two are *concatenated*. Serving all three reads
     * from one call makes it easy to even them out by accident,
     * and either direction of that mistake is silent: replacing
     * usersets drops stored grants, unioning a probe resurrects
     * the stored tuple a caller was overriding.
     */
    describe("the overlay replaces probes and concatenates usersets", () => {
      test("an unconditioned contextual tuple overrides a conditioned stored one", async () => {
        // The stored tuple names a condition that does not exist,
        // so evaluating it throws. Nothing should evaluate it: the
        // contextual tuple takes its place entirely.
        store.tuples.push(
          makeTuple({
            objectType: "doc",
            objectId: "1",
            relation: "viewer",
            subjectType: "user",
            subjectId: "alice",
            conditionName: "missing",
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

      test("a contextual wildcard overrides a conditioned stored one", async () => {
        store.relationConfigs.push(
          makeConfig({
            objectType: "doc",
            relation: "public",
            directlyAssignable: [
              { type: "user" },
              { type: "user", wildcard: true },
              { type: "user", condition: "missing" },
            ],
          }),
        );
        store.tuples.push(
          makeTuple({
            objectType: "doc",
            objectId: "1",
            relation: "public",
            subjectType: "user",
            subjectId: "*",
            conditionName: "missing",
          }),
        );

        expect(
          await check(store, {
            objectType: "doc",
            objectId: "1",
            relation: "public",
            subjectType: "user",
            subjectId: "alice",
            contextualTuples: [
              {
                objectType: "doc",
                objectId: "1",
                relation: "public",
                subjectType: "user",
                subjectId: "*",
              },
            ],
          }),
        ).toBe(true);
      });

      test("a contextual userset does not hide a stored one", async () => {
        // Only the *stored* userset leads to alice. If contextual
        // rows replaced stored ones the way probes do, the grant
        // would disappear.
        store.relationConfigs.push(
          makeConfig({
            objectType: "team",
            relation: "member",
            directlyAssignable: [{ type: "user" }],
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
          makeTuple({
            objectType: "team",
            objectId: "writers",
            relation: "member",
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
            contextualTuples: [
              {
                objectType: "doc",
                objectId: "1",
                relation: "viewer",
                subjectType: "team",
                subjectId: "readers",
                subjectRelation: "member",
              },
            ],
          }),
        ).toBe(true);
      });

      test("a probe the overlay answers is dropped from the store query", async () => {
        // Replacement means the stored row can never be used, so
        // asking for it is wasted work. The userset part is still
        // asked for, because there both halves are kept.
        store.tuples.push(
          makeTuple({
            objectType: "doc",
            objectId: "1",
            relation: "viewer",
            subjectType: "user",
            subjectId: "alice",
          }),
        );
        const overlay = new ContextualTupleStore(store, [
          {
            objectType: "doc",
            objectId: "1",
            relation: "viewer",
            subjectType: "user",
            subjectId: "alice",
          },
        ]);
        store.resetCounts();

        await overlay.findCheckTuples({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          directRefs: null,
          wildcardRefs: null,
          usersetRefs: null,
        });

        const [inner] = store.queriesFor("doc", "1", "viewer");
        // Suppressed with `[]`, not `null`. `null` would say
        // "unrestricted" and reopen the probe the overlay just
        // answered — the fail-open reading of this field.
        expect(inner?.directRefs).toEqual([]);
        expect(inner?.wildcardRefs).toBeNull();
        expect(inner?.usersetRefs).toBeNull();
      });
    });
  });

  describe("Max depth protection", () => {
    /**
     * Build a computedUserset chain lvl0 -> lvl1 -> ... -> lvlN
     * with a direct tuple at lvlN, all on doc:1. Every hop is a
     * rewrite of the same object, so the whole chain costs zero
     * depth.
     */
    function buildRewriteChain(length: number) {
      for (let i = 0; i < length; i++) {
        store.relationConfigs.push(
          makeConfig({
            objectType: "doc",
            relation: `lvl${i}`,
            computedUserset: `lvl${i + 1}`,
          }),
        );
      }
      // The rung the direct tuple sits on rewrites nothing, but it
      // is still a relation the check resolves, so it needs a
      // config like every other.
      declareRelations(store, `doc.lvl${length}`);
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

    /**
     * Build a userset chain group:0#member <- group:1#member <-
     * ... <- group:N#member with a direct tuple at group:N.
     * Resolving group:0 takes N dispatches, so it needs a budget
     * of N + 1.
     */
    function buildUsersetChain(length: number) {
      store.relationConfigs.push(
        makeConfig({
          objectType: "group",
          relation: "member",
          directlyAssignable: [
            { type: "user" },
            { type: "team", relation: "member" },
            { type: "group", relation: "member" },
            { type: "org", relation: "member" },
            { type: "workspace", relation: "member" },
            { type: "blocklist", relation: "member" },
          ],
        }),
      );
      for (let i = 0; i < length; i++) {
        store.tuples.push(
          makeTuple({
            objectType: "group",
            objectId: String(i),
            relation: "member",
            subjectType: "group",
            subjectId: String(i + 1),
            subjectRelation: "member",
          }),
        );
      }
      store.tuples.push(
        makeTuple({
          objectType: "group",
          objectId: String(length),
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
    }

    const groupRequest = {
      objectType: "group",
      objectId: "0",
      relation: "member",
      subjectType: "user",
      subjectId: "alice",
    };

    test("rewrites of the same object cost no depth", async () => {
      // Three computed-userset hops resolve on the smallest legal
      // budget. OpenFGA increments resolution depth only when it
      // dispatches to another object; a rewrite ladder never
      // exhausts the budget however long it is.
      buildRewriteChain(3);
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
          { maxDepth: 1 },
        ),
      ).toBe(true);
    });

    test("resolves when dispatch depth is exactly at the limit", async () => {
      // Root plus three dispatches occupies depths 0..3, so the
      // budget must be 4: the guard trips on `depth === maxDepth`.
      buildUsersetChain(3);
      expect(await check(store, groupRequest, { maxDepth: 4 })).toBe(true);
    });

    test("throws DepthExceededError beyond the limit", async () => {
      buildUsersetChain(3);
      await expect(
        check(store, groupRequest, { maxDepth: 3 }),
      ).rejects.toBeInstanceOf(DepthExceededError);
    });
  });

  describe("Cycle detection", () => {
    const aRequest = {
      objectType: "doc",
      objectId: "1",
      relation: "a",
      subjectType: "user",
      subjectId: "alice",
    };

    test("cyclic implied_by denies instead of erroring", async () => {
      // OpenFGA returns Allowed:false with an internal
      // CycleDetected flag; only depth exhaustion is an error.
      store.relationConfigs.push(
        makeConfig({ objectType: "doc", relation: "a", impliedBy: ["b"] }),
        makeConfig({ objectType: "doc", relation: "b", impliedBy: ["a"] }),
      );

      expect(await check(store, aRequest)).toBe(false);
    });

    test("a granting sibling beats a cyclic union branch", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "a",
          impliedBy: ["b", "admin"],
        }),
        makeConfig({ objectType: "doc", relation: "b", impliedBy: ["a"] }),
        makeConfig({
          objectType: "doc",
          relation: "admin",
          directlyAssignable: [{ type: "user" }],
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

      expect(await check(store, aRequest)).toBe(true);
    });

    test("a cycle in an intersection operand denies", async () => {
      // The operand could not be resolved, so it cannot be shown
      // to hold: fail closed, even though the other operand grants.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "a",
          intersection: [
            { type: "computedUserset", relation: "member" },
            { type: "computedUserset", relation: "b" },
          ],
        }),
        makeConfig({ objectType: "doc", relation: "b", impliedBy: ["a"] }),
        makeConfig({
          objectType: "doc",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(await check(store, aRequest)).toBe(false);
    });

    test("a cycle on the base side of an exclusion denies", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "a",
          impliedBy: ["b"],
          excludedBy: "banned",
        }),
        makeConfig({ objectType: "doc", relation: "b", impliedBy: ["a"] }),
        makeConfig({
          objectType: "doc",
          relation: "banned",
          directlyAssignable: [{ type: "user" }],
        }),
      );

      expect(await check(store, aRequest)).toBe(false);
    });

    test("a cycle on the subtract side of an exclusion denies", async () => {
      // The case that makes indeterminacy worth tracking. The base
      // grants outright; treating the cycled subtract branch as a
      // plain `false` would read as "not excluded" and grant —
      // fail-open. OpenFGA short-circuits to deny instead.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "a",
          directlyAssignable: [{ type: "user" }],
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
          relation: "a",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(await check(store, aRequest)).toBe(false);
    });

    test("long rewrite cycle terminates without the depth guard", async () => {
      // 40 rewrite hops on doc:1 closing back on lvl0 — longer than
      // the default budget of 25, but rewrites cost no depth, so
      // only the resolution path can stop it. It must settle, not
      // hang. This is the safety argument for charging no depth on
      // rewrites: one object has a finite set of relations, so the
      // path Set always closes the loop.
      const length = 40;
      for (let i = 0; i < length; i++) {
        store.relationConfigs.push(
          makeConfig({
            objectType: "doc",
            relation: `lvl${i}`,
            computedUserset: i === length - 1 ? "lvl0" : `lvl${i + 1}`,
          }),
        );
      }

      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "lvl0",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toBe(false);
    });

    test("recursive-shape loop is indeterminate (known divergence)", async () => {
      // group:a#member -> group:b#member -> group:a#member, on a
      // single self-referencing relation. OpenFGA routes this
      // shape to a recursive resolver that walks the reachable
      // set iteratively and returns a definitive `false`, so on
      // the subtract side of a but-not it GRANTS. tsfga has one
      // resolver, sees a path cycle, and denies.
      //
      // Pinned deliberately: it is the only position where the
      // two engines disagree about cycles, it fails closed, and
      // it is documented in the package README. Verified against
      // OpenFGA v1.18.2 — see tests/conformance/cycles.test.ts,
      // which covers every position where they do agree.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "a",
          directlyAssignable: [{ type: "user" }],
          excludedBy: "cyclic",
        }),
        makeConfig({
          objectType: "doc",
          relation: "cyclic",
          directlyAssignable: [
            { type: "group" },
            { type: "team", relation: "member" },
            { type: "group", relation: "member" },
            { type: "org", relation: "member" },
            { type: "workspace", relation: "member" },
            { type: "blocklist", relation: "member" },
          ],
        }),
        makeConfig({
          objectType: "group",
          relation: "member",
          directlyAssignable: [
            { type: "user" },
            { type: "group" },
            { type: "team", relation: "member" },
            { type: "group", relation: "member" },
            { type: "org", relation: "member" },
            { type: "workspace", relation: "member" },
            { type: "blocklist", relation: "member" },
          ],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "a",
          subjectType: "user",
          subjectId: "alice",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "cyclic",
          subjectType: "group",
          subjectId: "a",
          subjectRelation: "member",
        }),
        makeTuple({
          objectType: "group",
          objectId: "a",
          relation: "member",
          subjectType: "group",
          subjectId: "b",
          subjectRelation: "member",
        }),
        makeTuple({
          objectType: "group",
          objectId: "b",
          relation: "member",
          subjectType: "group",
          subjectId: "a",
          subjectRelation: "member",
        }),
      );

      // OpenFGA answers true here; tsfga denies.
      expect(await check(store, aRequest)).toBe(false);
    });

    test("depth exhaustion still errors, unlike a cycle", async () => {
      // The two used to be one code path; they are now distinct and
      // must stay so — converting exhaustion to `false` would fail
      // open inside an exclusion.
      store.relationConfigs.push(
        makeConfig({
          objectType: "group",
          relation: "member",
          directlyAssignable: [
            { type: "user" },
            { type: "team", relation: "member" },
            { type: "group", relation: "member" },
            { type: "org", relation: "member" },
            { type: "workspace", relation: "member" },
            { type: "blocklist", relation: "member" },
          ],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "group",
          objectId: "0",
          relation: "member",
          subjectType: "group",
          subjectId: "1",
          subjectRelation: "member",
        }),
      );

      await expect(
        check(
          store,
          {
            objectType: "group",
            objectId: "0",
            relation: "member",
            subjectType: "user",
            subjectId: "alice",
          },
          { maxDepth: 1 },
        ),
      ).rejects.toBeInstanceOf(DepthExceededError);
    });
  });

  describe("Union error semantics", () => {
    /**
     * member is implied by a branch whose config read fails and by
     * admin. The error source is deliberately *not* a cycle: the
     * contract here is about any failing branch.
     */
    function unionStore(): ConfigErrorStore {
      const erring = new ConfigErrorStore(["broken"]);
      erring.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "member",
          impliedBy: ["broken", "admin"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "admin",
          directlyAssignable: [{ type: "user" }],
        }),
      );
      return erring;
    }

    const memberRequest = {
      objectType: "doc",
      objectId: "1",
      relation: "member",
      subjectType: "user",
      subjectId: "alice",
    };

    test("true branch wins over an erroring sibling branch", async () => {
      const erring = unionStore();
      erring.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "admin",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(await check(erring, memberRequest)).toBe(true);
    });

    test("propagates error when no sibling branch grants", async () => {
      // alice has no admin tuple: the failing branch's error must
      // surface instead of resolving false.
      await expect(check(unionStore(), memberRequest)).rejects.toBeInstanceOf(
        StoreReadFailure,
      );
    });
  });

  describe("Exclusion fails closed on a failed branch", () => {
    test("errored exclusion branch throws instead of granting", async () => {
      // carl has a direct editor tuple, but the excludedBy relation
      // cannot be resolved. Pre-0.3.0 this failed open: the
      // truncated exclusion read as "not excluded" and granted.
      const erring = new ConfigErrorStore(["banned"]);
      erring.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "editor",
          directlyAssignable: [{ type: "user" }],
          excludedBy: "banned",
        }),
      );
      erring.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "carl",
        }),
      );

      await expect(
        check(erring, {
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "carl",
        }),
      ).rejects.toBeInstanceOf(StoreReadFailure);
    });

    test("deep exclusion branch throws instead of granting", async () => {
      // The exclusion chain needs more depth than maxDepth allows.
      // It has to be a *userset* chain: rewrites of doc:1 cost no
      // depth, so only dispatch to another object can exhaust the
      // budget.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "editor",
          directlyAssignable: [{ type: "user" }],
          excludedBy: "banned",
        }),
        makeConfig({
          objectType: "doc",
          relation: "banned",
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
            { type: "robot" },
            { type: "robot", wildcard: true },
            { type: "team" },
            { type: "team", wildcard: true },
            { type: "group" },
            { type: "group", wildcard: true },
            { type: "org" },
            { type: "org", wildcard: true },
            { type: "workspace" },
            { type: "workspace", wildcard: true },
            { type: "blocklist" },
            { type: "blocklist", wildcard: true },
            { type: "team", relation: "member" },
            { type: "group", relation: "member" },
            { type: "org", relation: "member" },
            { type: "workspace", relation: "member" },
            { type: "blocklist", relation: "member" },
          ],
        }),
        makeConfig({
          objectType: "blocklist",
          relation: "member",
          directlyAssignable: [
            { type: "user" },
            { type: "team", relation: "member" },
            { type: "group", relation: "member" },
            { type: "org", relation: "member" },
            { type: "workspace", relation: "member" },
            { type: "blocklist", relation: "member" },
          ],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "banned",
          subjectType: "blocklist",
          subjectId: "0",
          subjectRelation: "member",
        }),
      );
      for (let i = 0; i < 5; i++) {
        store.tuples.push(
          makeTuple({
            objectType: "blocklist",
            objectId: String(i),
            relation: "member",
            subjectType: "blocklist",
            subjectId: String(i + 1),
            subjectRelation: "member",
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
      const erring = new ConfigErrorStore(["banned"]);
      erring.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "editor",
          directlyAssignable: [{ type: "user" }],
          excludedBy: "banned",
        }),
      );
      // No editor tuple: definite deny regardless of exclusion.
      expect(
        await check(erring, {
          objectType: "doc",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "carl",
        }),
      ).toBe(false);
    });
  });

  describe("Definitive deny beats sibling error (OpenFGA parity)", () => {
    /** can_view = member AND broken, where broken's config read fails. */
    function intersectionStore(): ConfigErrorStore {
      const erring = new ConfigErrorStore(["broken"]);
      erring.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "can_view",
          intersection: [
            { type: "computedUserset", relation: "member" },
            { type: "computedUserset", relation: "broken" },
          ],
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
            { type: "robot" },
            { type: "robot", wildcard: true },
            { type: "team" },
            { type: "team", wildcard: true },
            { type: "group" },
            { type: "group", wildcard: true },
            { type: "org" },
            { type: "org", wildcard: true },
            { type: "workspace" },
            { type: "workspace", wildcard: true },
            { type: "blocklist" },
            { type: "blocklist", wildcard: true },
          ],
        }),
        makeConfig({
          objectType: "doc",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
        }),
      );
      return erring;
    }

    /** viewer = broken BUT NOT banned, where broken's read fails. */
    function exclusionStore(): ConfigErrorStore {
      const erring = new ConfigErrorStore(["broken"]);
      erring.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          impliedBy: ["broken"],
          excludedBy: "banned",
        }),
        makeConfig({
          objectType: "doc",
          relation: "banned",
          directlyAssignable: [{ type: "user" }],
        }),
      );
      return erring;
    }

    const canViewRequest = {
      objectType: "doc",
      objectId: "1",
      relation: "can_view",
      subjectType: "user",
      subjectId: "alice",
    };
    const viewerRequest = {
      objectType: "doc",
      objectId: "1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    };

    test("intersection: false operand overrides erroring operand", async () => {
      // OpenFGA's intersection swallows errors when another
      // operand is definitively false.
      // alice is not a member: false wins over the read failure.
      expect(await check(intersectionStore(), canViewRequest)).toBe(false);
    });

    test("intersection: true operand plus error still throws", async () => {
      const erring = intersectionStore();
      erring.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      // No operand is definitively false: fail closed on the error.
      await expect(check(erring, canViewRequest)).rejects.toBeInstanceOf(
        StoreReadFailure,
      );
    });

    test("exclusion: granted exclusion branch overrides base error", async () => {
      // OpenFGA short-circuits to deny when the subtracted branch
      // grants, even if the base errored.
      const erring = exclusionStore();
      erring.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "banned",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      // The base errors but alice is banned: deny.
      expect(await check(erring, viewerRequest)).toBe(false);
    });

    test("exclusion: base error with false exclusion still throws", async () => {
      // alice is not banned: the base error must fail closed.
      await expect(
        check(exclusionStore(), viewerRequest),
      ).rejects.toBeInstanceOf(StoreReadFailure);
    });
  });

  describe("A relation the model does not define", () => {
    /**
     * The row is pushed onto the store, never written through
     * `addTuple`.
     *
     * That is not a shortcut: `addTuple` refuses a tuple whose
     * relation has no config, so the write path could not create
     * this state and a test built on it would prove nothing. A row
     * that outlives its config is how a deployment reaches it — a
     * deleted config, an out-of-band writer, a half-applied
     * fixture — and the row then read as *unrestricted* and
     * granted, where OpenFGA answers HTTP 400.
     */
    const request = {
      objectType: "doc",
      objectId: "1",
      relation: "reviewer",
      subjectType: "user",
      subjectId: "alice",
    };

    beforeEach(() => {
      // The model has to define `user` for the test to be about the
      // relation gate at all — the subject gate is checked first.
      declareSubjectTypes(store);
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "reviewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
    });

    test("a stored row on it no longer grants", async () => {
      await expect(check(store, request)).rejects.toBeInstanceOf(
        RelationConfigNotFoundError,
      );
    });

    test("the same row grants once the relation is declared", async () => {
      // The control: the row itself is fine, and nothing here
      // refuses rows on principle.
      declareRelations(store, "doc.reviewer");

      expect(await check(store, request)).toBe(true);
    });

    test("a relation reached by a rewrite is refused too", async () => {
      // The rewrite targets are resolved as nodes of their own, so
      // the gate cannot be applied only to the requested relation.
      declareRelations(store, "doc.viewer");
      const viewer = store.relationConfigs.find((c) => c.relation === "viewer");
      if (viewer) viewer.computedUserset = "undefined_relation";

      await expect(
        check(store, { ...request, relation: "viewer" }),
      ).rejects.toBeInstanceOf(RelationConfigNotFoundError);
    });

    test("a tupleset type without the computed relation is skipped", async () => {
      // The one exception, and it is upstream's: a model is valid
      // when *some* of the tupleset's types define the computed
      // relation, and the rows whose type does not are dropped as
      // the dispatches are produced. Raising here would answer a
      // refusal where OpenFGA answers `false`.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
        }),
      );
      declareRelations(store, "doc.parent", "team.member");
      store.tuples.push(
        // `org` has no `member` relation; `team` does.
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "parent",
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

      expect(await check(store, { ...request, relation: "viewer" })).toBe(
        false,
      );

      // The control: the same shape through a type that *does*
      // define the relation still grants.
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "parent",
          subjectType: "team",
          subjectId: "eng",
        }),
        makeTuple({
          objectType: "team",
          objectId: "eng",
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(await check(store, { ...request, relation: "viewer" })).toBe(true);
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
      declareRelations(
        store,
        "project.owner",
        "project.partner",
        "org.project_editor",
      );
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
      declareRelations(
        store,
        "project.owner",
        "project.partner",
        "org.project_editor",
      );
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
      declareRelations(
        store,
        "project.owner",
        "project.partner",
        "org.project_editor",
      );
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
          directlyAssignable: [{ type: "user" }],
          intersection: [
            { type: "direct" },
            { type: "computedUserset", relation: "approved" },
          ],
        }),
        makeConfig({
          objectType: "doc",
          relation: "approved",
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [{ type: "user" }],
          intersection: [
            { type: "direct" },
            { type: "computedUserset", relation: "approved" },
          ],
          excludedBy: "banned",
        }),
        makeConfig({
          objectType: "doc",
          relation: "approved",
          directlyAssignable: [{ type: "user" }],
        }),
        makeConfig({
          objectType: "doc",
          relation: "banned",
          directlyAssignable: [{ type: "user" }],
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
      declareSubjectTypes(store);
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
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
          ],
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
          directlyAssignable: [{ type: "user" }, { type: "team" }],
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
      ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
    });
  });

  /**
   * Upstream's `ValidateUser` refuses a `user` whose type the model
   * does not define, before any resolution runs. tsfga read such a
   * type as one no row mentions, so every read missed and the
   * answer was `false` — a misspelled type indistinguishable from a
   * real denial.
   */
  describe("An undefined subject type", () => {
    beforeEach(() => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignable: [{ type: "user" }, { type: "team" }],
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
      );
    });

    test("is refused rather than answered", async () => {
      await expect(
        check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "no_such_type",
          subjectId: "alice",
        }),
      ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
    });

    test("names the cause, and no allow-list", async () => {
      // `allowed` is empty because the restrictions were never
      // consulted — the refusal is decided ahead of them.
      const error = await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "no_such_type",
        subjectId: "alice",
      }).catch((raised: unknown) => raised);
      expect(error).toBeInstanceOf(InvalidSubjectTypeError);
      if (error instanceof InvalidSubjectTypeError) {
        expect(error.cause).toBe("undefined subject type");
        expect(error.allowed).toEqual([]);
      }
    });

    test("is decided before the subject relation is resolved", async () => {
      // Upstream reports the type first, and the order is
      // observable: a userset subject of an undefined type is
      // refused for its type, not for its relation.
      const error = await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "no_such_type",
        subjectId: "writers",
        subjectRelation: "member",
      }).catch((raised: unknown) => raised);
      expect(error).toBeInstanceOf(InvalidSubjectTypeError);
    });

    test("listObjects inherits the same refusal", async () => {
      await expect(
        createTsfga(store).listObjects({
          objectType: "doc",
          relation: "viewer",
          subjectType: "no_such_type",
          subjectId: "alice",
        }),
      ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
    });

    test("a defined type the relation does not admit still answers", async () => {
      // The boundary the gate must not cross: `team` is defined —
      // `doc.viewer` names it — and a `team` subject with no row
      // simply does not hold. Definedness, not admissibility.
      expect(
        await check(store, {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "team",
          subjectId: "writers",
        }),
      ).toBe(false);
    });

    test("a type with no relations of its own is defined", async () => {
      // `user` has no relation config anywhere in this fixture. It
      // is defined by the restriction that admits it, and that is
      // the half of the rule the whole corpus depends on.
      expect(store.relationConfigs.some((c) => c.objectType === "user")).toBe(
        false,
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

    test("the store is asked about a type once per call", async () => {
      // The gate runs per check, and `listObjects` runs one check
      // per candidate. Without the scope's cache a thousand
      // candidates would be a thousand identical reads.
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "2",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "3",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      store.resetCounts();
      await createTsfga(store).listObjects({
        objectType: "doc",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      });
      expect(store.counts.hasTypeDefinition).toBe(1);
    });
  });

  describe("Slack model (combined steps)", () => {
    beforeEach(() => {
      // Relation configs
      store.relationConfigs.push(
        makeConfig({
          objectType: "workspace",
          relation: "legacy_admin",
          directlyAssignable: [{ type: "user" }],
        }),
        makeConfig({
          objectType: "workspace",
          relation: "channels_admin",
          directlyAssignable: [{ type: "user" }],
          impliedBy: ["legacy_admin"],
        }),
        makeConfig({
          objectType: "workspace",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
          impliedBy: ["channels_admin"],
        }),
        makeConfig({
          objectType: "workspace",
          relation: "guest",
          directlyAssignable: [{ type: "user" }],
        }),
        makeConfig({
          objectType: "channel",
          relation: "writer",
          directlyAssignable: [
            { type: "user" },
            { type: "workspace" },
            { type: "team", relation: "member" },
            { type: "group", relation: "member" },
            { type: "org", relation: "member" },
            { type: "workspace", relation: "member" },
            { type: "blocklist", relation: "member" },
          ],
        }),
        makeConfig({
          objectType: "channel",
          relation: "commenter",
          directlyAssignable: [
            { type: "user" },
            { type: "workspace" },
            { type: "team", relation: "member" },
            { type: "group", relation: "member" },
            { type: "org", relation: "member" },
            { type: "workspace", relation: "member" },
            { type: "blocklist", relation: "member" },
          ],
          impliedBy: ["writer"],
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
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
          ],
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

    test("throws InvalidSubjectTypeError when forbidden", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignable: [{ type: "user" }, { type: "team" }],
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
      ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
    });
  });

  describe("listObjects", () => {
    beforeEach(() => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          // Both forms, because one of these tests grants through a
          // conditioned row. A restriction matches its condition
          // exactly, so `[{ type: "user" }]` alone would drop that
          // row before anything evaluated the condition.
          directlyAssignable: [
            { type: "user" },
            { type: "user", condition: "in_region" },
          ],
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
      expect(
        await fga.listObjects({
          objectType: "doc",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).toEqual(["1"]);
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
      const request = {
        objectType: "doc",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      };
      expect(
        await fga.listObjects({ ...request, context: { region: "us" } }),
      ).toEqual(["1", "3"]);
      expect(
        await fga.listObjects({ ...request, context: { region: "eu" } }),
      ).toEqual(["1"]);
    });
  });

  describe("listSubjects", () => {
    test("returns direct subjects for object + relation", async () => {
      declareRelations(store, "doc.viewer");
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
      // One userset hop: group:0 sits at depth 0 and group:1 at
      // depth 1, so a budget of 1 is exhausted and 2 resolves.
      store.relationConfigs.push(
        makeConfig({
          objectType: "group",
          relation: "member",
          directlyAssignable: [
            { type: "user" },
            { type: "team", relation: "member" },
            { type: "group", relation: "member" },
            { type: "org", relation: "member" },
            { type: "workspace", relation: "member" },
            { type: "blocklist", relation: "member" },
          ],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "group",
          objectId: "0",
          relation: "member",
          subjectType: "group",
          subjectId: "1",
          subjectRelation: "member",
        }),
        makeTuple({
          objectType: "group",
          objectId: "1",
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      const request = {
        objectType: "group",
        objectId: "0",
        relation: "member",
        subjectType: "user",
        subjectId: "alice",
      };

      const shallow = createTsfga(store, { maxDepth: 1 });
      await expect(shallow.check(request)).rejects.toBeInstanceOf(
        DepthExceededError,
      );

      const deep = createTsfga(store, { maxDepth: 2 });
      expect(await deep.check(request)).toBe(true);
    });
  });
});

/**
 * The model-shape prune (`type-graph.ts`). Upstream refuses a node
 * whose `objectType#relation` the subject's type cannot reach, at
 * every node, before the rewrite is resolved. These fix the shape
 * of that answer rather than only its boolean: a prune is a
 * *definitive* denial, and the difference between a definitive
 * `false` and a cycle-truncated one is visible one level up.
 */
describe("reachability prune", () => {
  /** `bot` is the only entrypoint, so no `user` ever reaches it. */
  function seedUnreachable(store: MockTupleStore): MockTupleStore {
    store.relationConfigs.push(
      makeConfig({
        objectType: "ring",
        relation: "member",
        directlyAssignable: [
          { type: "bot" },
          { type: "ring", relation: "member" },
        ],
      }),
      makeConfig({
        objectType: "doc",
        relation: "via_ring",
        directlyAssignable: [{ type: "ring", relation: "member" }],
      }),
      makeConfig({
        objectType: "doc",
        relation: "granted",
        directlyAssignable: [{ type: "user" }],
      }),
      makeConfig({
        objectType: "doc",
        relation: "ring_excluded",
        directlyAssignable: [],
        computedUserset: "granted",
        excludedBy: "via_ring",
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "ring",
        objectId: "r1",
        relation: "member",
        subjectType: "ring",
        subjectId: "r2",
        subjectRelation: "member",
      }),
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "via_ring",
        subjectType: "ring",
        subjectId: "r1",
        subjectRelation: "member",
      }),
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "granted",
        subjectType: "user",
        subjectId: "alice",
      }),
    );
    return store;
  }

  const alice = { subjectType: "user", subjectId: "alice" };

  test("a subtree the subject's type cannot reach denies", async () => {
    const store = seedUnreachable(new MockTupleStore());
    expect(
      await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "via_ring",
        ...alice,
      }),
    ).toBe(false);
  });

  test("the prune reads no tuples for the node it denies", async () => {
    const store = seedUnreachable(new MockTupleStore());
    store.resetCounts();
    await check(store, {
      objectType: "doc",
      objectId: "1",
      relation: "via_ring",
      ...alice,
    });
    expect(store.counts.findCheckTuples ?? 0).toBe(0);
  });

  // The whole reason the prune returns the unflagged `DENIED`: on
  // the subtract side of an exclusion a cycle-truncated `false`
  // *denies*, so a prune that reported a cycle would leave this
  // case answering `false` where OpenFGA answers `true`.
  test("a pruned subtrahend does not deny the exclusion", async () => {
    const store = seedUnreachable(new MockTupleStore());
    expect(
      await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "ring_excluded",
        ...alice,
      }),
    ).toBe(true);
  });

  test("a typed wildcard keeps a subject reachable", async () => {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "public",
        directlyAssignable: [{ type: "user", wildcard: true }],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "public",
        subjectType: "user",
        subjectId: "*",
      }),
    );
    expect(
      await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "public",
        ...alice,
      }),
    ).toBe(true);
  });

  test("a relation with no config is still refused, not pruned", async () => {
    const store = seedUnreachable(new MockTupleStore());
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "undefined_here",
        ...alice,
      }),
    ).rejects.toBeInstanceOf(RelationConfigNotFoundError);
  });

  // A rewrite naming a relation the model does not define leaves
  // the walk unable to settle the question. It must then prune
  // nothing, so the node's own resolution raises as it always did.
  test("an unresolvable rewrite leaves the answer open", async () => {
    const store = new MockTupleStore();
    // `viewer` admits only `bot`, so nothing else here defines the
    // subject's type and the refusal under test would be preempted
    // by the subject gate.
    declareSubjectTypes(store);
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "bot" }],
        impliedBy: ["missing"],
      }),
    );
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        ...alice,
      }),
    ).rejects.toBeInstanceOf(RelationConfigNotFoundError);
  });

  // A TTU reaches whoever holds the computed relation on a type the
  // tupleset admits — and only those. `folder#viewer` admits users;
  // `org` does not define `viewer` at all, so it contributes no
  // edge and no refusal.
  test("a tuple-to-userset carries reachability through", async () => {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "parent",
        directlyAssignable: [{ type: "folder" }, { type: "org" }],
      }),
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
      makeConfig({
        objectType: "folder",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
      // `robot` is checked below as a subject the walk prunes. It
      // has to be a type the model *defines* for that to be what
      // the second assertion measures: an undefined one is refused
      // instead, one gate earlier.
      makeConfig({
        objectType: "shed",
        relation: "keeps",
        directlyAssignable: [{ type: "robot" }],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "parent",
        subjectType: "folder",
        subjectId: "f1",
      }),
      makeTuple({
        objectType: "folder",
        objectId: "f1",
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
        ...alice,
      }),
    ).toBe(true);
    expect(
      await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "robot",
        subjectId: "r2d2",
      }),
    ).toBe(false);
  });
});

/**
 * Each `tupleToUserset` entry is its own union branch, as upstream
 * makes each `checkTTU` its own child of the union. One arm whose
 * tupleset row cannot be evaluated must not sink an arm beside it
 * that grants.
 */
describe("tuple-to-userset arms are independent", () => {
  function seedArms(): MockTupleStore {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "valid_ip",
      expression: 'user_ip == "192.168.0.1"',
      parameters: { user_ip: "string" },
    });
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "parent",
        directlyAssignable: [{ type: "folder", condition: "valid_ip" }],
      }),
      makeConfig({
        objectType: "doc",
        relation: "owner",
        directlyAssignable: [{ type: "org" }],
      }),
      makeConfig({
        objectType: "doc",
        relation: "two_arms",
        directlyAssignable: [],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "viewer" },
          { tupleset: "owner", computedUserset: "viewer" },
        ],
      }),
      makeConfig({
        objectType: "folder",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
      makeConfig({
        objectType: "org",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    store.tuples.push(
      // The broken arm: a condition with no stored context, which a
      // context-free check cannot evaluate.
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "parent",
        subjectType: "folder",
        subjectId: "f1",
        conditionName: "valid_ip",
      }),
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "owner",
        subjectType: "org",
        subjectId: "o1",
      }),
    );
    return store;
  }

  test("a broken arm does not sink the arm beside it", async () => {
    const store = seedArms();
    store.tuples.push(
      makeTuple({
        objectType: "org",
        objectId: "o1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    );
    expect(
      await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "two_arms",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).toBe(true);
  });

  // The swallow rule is unchanged: an arm's error is discarded only
  // because something else granted. With nothing granting, it is
  // still the answer.
  test("a broken arm still raises when nothing grants", async () => {
    const store = seedArms();
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "two_arms",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

/**
 * A tuple-to-userset dispatch lands on the object the tupleset row
 * names, so that row has to *name an object*. A userset row would
 * have its subject relation discarded and the dispatch would land
 * on a different relation of the linked object; a wildcard row
 * names no object at all and the dispatch would ask for object id
 * `"*"`.
 *
 * `config-validation.ts` refuses both shapes at model write —
 * `tupleset relation admits a userset` and `tupleset relation
 * admits a wildcard` — but only against the tupleset config that
 * exists *at the time the TTU is written*. Widening the tupleset
 * afterwards is not revalidated, which is the documented
 * write-order gap and the write order both tests below use. The
 * clamp in `resolveTupleset` is what makes that gap harmless, the
 * same call `clampToQuery` makes for `findCheckTuples`.
 */
describe("a tupleset row must name a concrete object", () => {
  test("a tupleset row naming a userset does not dispatch", async () => {
    const store = new MockTupleStore();
    const client = createTsfga(store);
    await client.writeRelationConfig(
      makeConfig({
        objectType: "folder",
        relation: "member",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    await client.writeRelationConfig(
      makeConfig({
        objectType: "folder",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    await client.writeRelationConfig(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
    );
    // Written *after* the TTU, so the "tupleset relation admits a
    // userset" rule never sees it.
    await client.writeRelationConfig(
      makeConfig({
        objectType: "doc",
        relation: "parent",
        directlyAssignable: [{ type: "folder", relation: "member" }],
      }),
    );
    await client.addTuple({
      objectType: "doc",
      objectId: "d1",
      relation: "parent",
      subjectType: "folder",
      subjectId: "f1",
      subjectRelation: "member",
    });
    // Alice is a viewer of the folder and deliberately not a
    // member, so a `true` here is the discarded `#member`.
    await client.addTuple({
      objectType: "folder",
      objectId: "f1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    });

    expect(
      await client.check({
        objectType: "doc",
        objectId: "d1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).toBe(false);
  });

  test("a tupleset row naming a wildcard does not dispatch", async () => {
    const store = new MockTupleStore();
    const client = createTsfga(store);
    await client.writeRelationConfig(
      makeConfig({
        objectType: "folder",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    await client.writeRelationConfig(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
    );
    await client.writeRelationConfig(
      makeConfig({
        objectType: "doc",
        relation: "parent",
        directlyAssignable: [{ type: "folder" }],
      }),
    );
    // The widening, again after the TTU was written.
    await client.writeRelationConfig(
      makeConfig({
        objectType: "doc",
        relation: "parent",
        directlyAssignable: [
          { type: "folder" },
          { type: "folder", wildcard: true },
        ],
      }),
    );
    await client.addTuple({
      objectType: "doc",
      objectId: "d1",
      relation: "parent",
      subjectType: "folder",
      subjectId: "*",
    });

    store.resetCounts();
    expect(
      await client.check({
        objectType: "doc",
        objectId: "d1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).toBe(false);

    // The answer is `false` on an opaque store either way; what
    // makes this a bug is the node the dispatch asks for. A store
    // holding its ids in a `uuid` column answers that read with a
    // driver error rather than a row.
    const dispatched = store.calls
      .filter((call) => call.method === "findCheckTuples")
      .map((call) => call.args[1]);
    expect(dispatched).not.toContain("*");
  });
});
