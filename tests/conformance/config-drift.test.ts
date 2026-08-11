import { describe, expect, test } from "bun:test";
import type {
  AddTupleRequest,
  RelationConfig,
  TypeRestriction,
} from "@tsfga/core";
import {
  expectConfigsMatchModel,
  type FixtureRecord,
  recordFixture,
} from "./helpers/conformance.ts";

/**
 * Tests for the drift check itself.
 *
 * Every fixture in this suite passed `expectConfigsMatchModel` the
 * first time it was run, which is the right outcome — the configs
 * were derived from these same models — and also exactly the
 * situation in which an assertion that cannot fail looks identical
 * to one that holds. So each way the check is supposed to go red
 * gets its own case here, driven by synthetic records rather than
 * by damaging a real fixture.
 *
 * No database and no OpenFGA: the check reads a `.dsl` file and
 * compares it against values in memory.
 */

const DIRECT_ACCESS = "./direct-access/model.dsl";
const ENTITLEMENTS = "./advanced-entitlements/model.dsl";

function config(
  objectType: string,
  relation: string,
  directlyAssignable: TypeRestriction[],
): RelationConfig {
  return {
    objectType,
    relation,
    directlyAssignable,
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  };
}

function record(
  configs: RelationConfig[],
  tupleRelations: string[] = [],
): FixtureRecord {
  return { configs, tupleRelations: new Set(tupleRelations) };
}

/** `direct-access` in full: two relations, each `[user]`. */
function directAccess(): RelationConfig[] {
  return [
    config("document", "viewer", [{ type: "user" }]),
    config("document", "editor", [{ type: "user" }]),
  ];
}

describe("the fixture drift check", () => {
  test("passes when the configs say what the model says", () => {
    expectConfigsMatchModel(DIRECT_ACCESS, record(directAccess()), {
      coverage: "complete",
    });
  });

  test("catches a widened restriction", () => {
    const configs = directAccess();
    configs[0] = config("document", "viewer", [
      { type: "user" },
      { type: "user", wildcard: true },
    ]);
    expect(() =>
      expectConfigsMatchModel(DIRECT_ACCESS, record(configs), {
        coverage: "complete",
      }),
    ).toThrow();
  });

  test("catches a narrowed restriction", () => {
    const configs = directAccess();
    configs[0] = config("document", "viewer", []);
    expect(() =>
      expectConfigsMatchModel(DIRECT_ACCESS, record(configs), {
        coverage: "complete",
      }),
    ).toThrow();
  });

  test("catches a config for a relation the model omits", () => {
    const configs = [
      ...directAccess(),
      config("document", "edtior", [{ type: "user" }]),
    ];
    expect(() =>
      expectConfigsMatchModel(DIRECT_ACCESS, record(configs), {
        coverage: "complete",
      }),
    ).toThrow();
  });

  test("catches a relation the model defines and nothing configures", () => {
    const configs = [config("document", "viewer", [{ type: "user" }])];
    expect(() =>
      expectConfigsMatchModel(DIRECT_ACCESS, record(configs), {
        coverage: "complete",
      }),
    ).toThrow();
  });

  describe("subset coverage", () => {
    test("allows a relation the fixture simply does not model", () => {
      expectConfigsMatchModel(
        DIRECT_ACCESS,
        record([config("document", "viewer", [{ type: "user" }])]),
        { coverage: "subset" },
      );
    });

    test("still requires a config for a relation a tuple targets", () => {
      // The forgotten-relation bug: on the read path a missing
      // config is *unrestricted*, so a check against it quietly
      // grants what the model would refuse.
      expect(() =>
        expectConfigsMatchModel(
          DIRECT_ACCESS,
          record(
            [config("document", "viewer", [{ type: "user" }])],
            ["document.editor"],
          ),
          { coverage: "subset" },
        ),
      ).toThrow();
    });
  });

  describe("exemptions verify themselves", () => {
    test("a tsfga-only helper must have no entry in the model", () => {
      const configs = [...directAccess(), config("document", "_helper", [])];
      expectConfigsMatchModel(DIRECT_ACCESS, record(configs), {
        coverage: "complete",
        tsfgaOnlyHelpers: ["document._helper"],
      });
    });

    test("a relation the model defines cannot be excused as tsfga-only", () => {
      expect(() =>
        expectConfigsMatchModel(DIRECT_ACCESS, record(directAccess()), {
          coverage: "complete",
          tsfgaOnlyHelpers: ["document.viewer"],
        }),
      ).toThrow();
    });

    test("a tsfga-only helper nothing writes is not a helper", () => {
      expect(() =>
        expectConfigsMatchModel(DIRECT_ACCESS, record(directAccess()), {
          coverage: "complete",
          tsfgaOnlyHelpers: ["document._absent"],
        }),
      ).toThrow();
    });

    test("a moved relation conserves what the model admitted", () => {
      const configs = [
        config("document", "viewer", [{ type: "user" }]),
        config("document", "editor", []),
        config("document", "_editor_direct", [{ type: "user" }]),
      ];
      expectConfigsMatchModel(DIRECT_ACCESS, record(configs), {
        coverage: "complete",
        tsfgaOnlyHelpers: ["document._editor_direct"],
        moved: [
          { relation: "document.editor", movedTo: "document._editor_direct" },
        ],
      });
    });

    test("a move that drops a ref on the floor fails", () => {
      const configs = [
        config("document", "viewer", [{ type: "user" }]),
        config("document", "editor", []),
        config("document", "_editor_direct", []),
      ];
      expect(() =>
        expectConfigsMatchModel(DIRECT_ACCESS, record(configs), {
          coverage: "complete",
          tsfgaOnlyHelpers: ["document._editor_direct"],
          moved: [
            { relation: "document.editor", movedTo: "document._editor_direct" },
          ],
        }),
      ).toThrow();
    });

    test("a move that leaves the original admitting fails", () => {
      const configs = [
        config("document", "viewer", [{ type: "user" }]),
        config("document", "editor", [{ type: "user" }]),
        config("document", "_editor_direct", [{ type: "user" }]),
      ];
      expect(() =>
        expectConfigsMatchModel(DIRECT_ACCESS, record(configs), {
          coverage: "complete",
          tsfgaOnlyHelpers: ["document._editor_direct"],
          moved: [
            { relation: "document.editor", movedTo: "document._editor_direct" },
          ],
        }),
      ).toThrow();
    });
  });

  describe("the condition is part of the restriction", () => {
    // `feature.has_feature` is four DSL entries over the same
    // `plan#subscriber` — one bare, three conditioned. They are
    // four distinct restrictions, not one written four ways.
    const entitlements = (hasFeature: TypeRestriction[]): FixtureRecord =>
      record([
        config("organization", "member", [{ type: "user" }]),
        config("plan", "subscriber", [
          { type: "organization", relation: "member" },
        ]),
        config("feature", "has_feature", hasFeature),
      ]);

    const ALL: TypeRestriction[] = [
      { type: "plan", relation: "subscriber" },
      {
        type: "plan",
        relation: "subscriber",
        condition: "is_below_collaborator_limit",
      },
      {
        type: "plan",
        relation: "subscriber",
        condition: "is_below_row_sync_limit",
      },
      {
        type: "plan",
        relation: "subscriber",
        condition: "is_below_page_history_days_limit",
      },
    ];

    test("passes when all four are named", () => {
      expectConfigsMatchModel(ENTITLEMENTS, entitlements(ALL), {
        coverage: "complete",
      });
    });

    test("catches dropping the conditions", () => {
      // What every fixture in this suite said before the config
      // could carry a condition. It reads as the same restriction
      // and is not: it admits an unconditioned tuple the model
      // refuses, and refuses the three conditioned ones it allows.
      expect(() =>
        expectConfigsMatchModel(
          ENTITLEMENTS,
          entitlements([{ type: "plan", relation: "subscriber" }]),
          { coverage: "complete" },
        ),
      ).toThrow();
    });

    test("catches naming the wrong condition", () => {
      expect(() =>
        expectConfigsMatchModel(
          ENTITLEMENTS,
          entitlements([
            ...ALL.slice(0, 3),
            {
              type: "plan",
              relation: "subscriber",
              condition: "is_below_some_other_limit",
            },
          ]),
          { coverage: "complete" },
        ),
      ).toThrow();
    });

    test("compares as a set, so order carries no meaning", () => {
      expectConfigsMatchModel(ENTITLEMENTS, entitlements([...ALL].reverse()), {
        coverage: "complete",
      });
    });
  });
});

describe("the fixture recorder", () => {
  test("captures configs and the relations tuples target", async () => {
    const written: string[] = [];
    const client = {
      writeRelationConfig: async (c: RelationConfig) => {
        written.push(`config:${c.relation}`);
      },
      addTuple: async (_tuple: AddTupleRequest) => {
        written.push("tuple");
      },
    };
    // The recorder's parameter is exactly these two methods, so a
    // stub of them is a legitimate argument rather than a cast.
    const fixture = recordFixture(client);

    await client.writeRelationConfig(
      config("document", "viewer", [{ type: "user" }]),
    );
    await client.addTuple({
      objectType: "document",
      objectId: "1",
      relation: "editor",
      subjectType: "user",
      subjectId: "2",
    });

    // The originals still ran — the recorder observes, it does not
    // replace.
    expect(written).toEqual(["config:viewer", "tuple"]);
    expect(fixture.configs).toHaveLength(1);
    expect(fixture.configs[0]?.relation).toBe("viewer");
    expect([...fixture.tupleRelations]).toEqual(["document.editor"]);
  });
});
