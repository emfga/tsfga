import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "src/core/check.ts";
import type { RelationConfig, Tuple } from "src/core/types.ts";
import { MockTupleStore } from "tests/helpers/mock-store.ts";

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
          tupleToUserset: {
            tupleset: "organization",
            computedUserset: "member",
          },
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
          tupleToUserset: {
            tupleset: "organization",
            computedUserset: "member",
          },
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

  describe("Max depth protection", () => {
    test("returns false when max depth exceeded", async () => {
      // Create circular implied_by
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "a",
          impliedBy: ["b"],
        }),
      );
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "b",
          impliedBy: ["a"],
        }),
      );

      expect(
        await check(
          store,
          {
            objectType: "doc",
            objectId: "1",
            relation: "a",
            subjectType: "user",
            subjectId: "alice",
          },
          { maxDepth: 5 },
        ),
      ).toBe(false);
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
