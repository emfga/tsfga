import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ErrorCode, FgaApiValidationError, OpenFgaClient } from "@openfga/sdk";
import {
  createTsfga,
  type RemoveTupleRequest,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectListObjectsConformance,
  expectWriteConformance,
  type FixtureRecord,
  recordFixture,
} from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";
import {
  assertUuidMapCovers,
  assertUuidMapInjective,
} from "./helpers/uuid-map.ts";

/**
 * A bank ledger with maker-checker and segregation of duties,
 * which is to say a model built almost entirely out of `but not`.
 *
 * `transfer_c3b.can_post` is `can_approve but not auditor`,
 * `can_approve` is `eligible_checker but not compliance_hold`, and
 * `eligible_checker` is `designated_checker but not maker`: three
 * exclusions stacked on one another, each subtracting from the
 * result of the last. The subtrahends are deliberately different
 * kinds — a direct row, a wildcard, and a second direct row — so
 * the stack is not three copies of one shape.
 *
 * `dual_control` then intersects the top of that stack with a
 * tuple-to-userset onto the account, so an approval has to survive
 * three subtractions *and* meet a condition resolved one dispatch
 * away.
 *
 * The interesting rows are the ones where a grant and a
 * subtraction reach the same user by different paths: `alice` is a
 * `designated_checker` only through `department_c3b:finance#member`,
 * which she is only a member of by being its `head`.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d574-000000000001"],
  ["finance", "00000000-0000-4000-d574-000000000002"],
  ["bob", "00000000-0000-4000-d574-000000000003"],
  ["carol", "00000000-0000-4000-d574-000000000004"],
  ["dan", "00000000-0000-4000-d574-000000000005"],
  ["ops", "00000000-0000-4000-d574-000000000006"],
  ["t1", "00000000-0000-4000-d574-000000000007"],
  ["t2", "00000000-0000-4000-d574-000000000008"],
  ["t3", "00000000-0000-4000-d574-000000000009"],
  ["erin", "00000000-0000-4000-d574-000000000010"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Ledger Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fgaClient: OpenFgaClient;
  let fixture: FixtureRecord;

  function can(
    objectType: string,
    objectId: string,
    relation: string,
    subject: string,
    expected: boolean,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(objectId),
        relation,
        subjectType: "user_c3b",
        subjectId: uuid(subject),
      },
      expected,
    );
  }

  async function revoke(tuple: RemoveTupleRequest): Promise<void> {
    const user = tuple.subjectRelation
      ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
      : `${tuple.subjectType}:${tuple.subjectId}`;
    const [, upstream] = await Promise.all([
      tsfga.removeTuple(tuple),
      fgaClient
        .deleteTuples(
          [
            {
              user,
              relation: tuple.relation,
              object: `${tuple.objectType}:${tuple.objectId}`,
            },
          ],
          { authorizationModelId },
        )
        .then(() => "deleted")
        .catch((error: unknown) => {
          if (
            error instanceof FgaApiValidationError &&
            error.apiErrorCode === ErrorCode.WriteFailedDueToInvalidInput
          ) {
            return "missing";
          }
          throw error;
        }),
    ]);
    expect("deleted").toBe(upstream);
  }

  beforeAll(async () => {
    assertUuidMapInjective(uuidMap);
    assertUuidMapCovers("./ledger/tuples.yaml", uuidMap);

    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;
    const departmentMember = {
      type: "department_c3b",
      relation: "member",
    } as const;

    await tsfga.writeRelationConfig({
      objectType: "department_c3b",
      relation: "head",
      directlyAssignable: [{ type: "user_c3b" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "department_c3b",
      relation: "member",
      directlyAssignable: [{ type: "user_c3b" }],
      ...plain,
      impliedBy: ["head"],
    });

    await tsfga.writeRelationConfig({
      objectType: "account_c3b",
      relation: "department",
      directlyAssignable: [{ type: "department_c3b" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "account_c3b",
      relation: "owner",
      directlyAssignable: [{ type: "user_c3b" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "account_c3b",
      relation: "viewer",
      directlyAssignable: [{ type: "user_c3b" }, departmentMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "account_c3b",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["viewer", "owner"],
      tupleToUserset: [{ tupleset: "department", computedUserset: "head" }],
    });

    await tsfga.writeRelationConfig({
      objectType: "transfer_c3b",
      relation: "account",
      directlyAssignable: [{ type: "account_c3b" }],
      ...plain,
    });
    for (const relation of ["maker", "auditor"]) {
      await tsfga.writeRelationConfig({
        objectType: "transfer_c3b",
        relation,
        directlyAssignable: [{ type: "user_c3b" }],
        ...plain,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "transfer_c3b",
      relation: "designated_checker",
      directlyAssignable: [{ type: "user_c3b" }, departmentMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "transfer_c3b",
      relation: "compliance_hold",
      directlyAssignable: [{ type: "user_c3b", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "transfer_c3b",
      relation: "eligible_checker",
      directlyAssignable: [],
      ...plain,
      computedUserset: "designated_checker",
      excludedBy: "maker",
    });
    await tsfga.writeRelationConfig({
      objectType: "transfer_c3b",
      relation: "can_approve",
      directlyAssignable: [],
      ...plain,
      computedUserset: "eligible_checker",
      excludedBy: "compliance_hold",
    });
    await tsfga.writeRelationConfig({
      objectType: "transfer_c3b",
      relation: "can_post",
      directlyAssignable: [],
      ...plain,
      computedUserset: "can_approve",
      excludedBy: "auditor",
    });
    await tsfga.writeRelationConfig({
      objectType: "transfer_c3b",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["maker", "designated_checker"],
      tupleToUserset: [{ tupleset: "account", computedUserset: "can_view" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "transfer_c3b",
      relation: "dual_control",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "can_approve" },
        {
          type: "tupleToUserset",
          tupleset: "account",
          computedUserset: "can_view",
        },
      ],
    });

    // === Tuples (mirroring ./ledger/tuples.yaml) ===
    await tsfga.addTuple({
      objectType: "department_c3b",
      objectId: uuid("finance"),
      relation: "head",
      subjectType: "user_c3b",
      subjectId: uuid("alice"),
    });
    for (const user of ["bob", "carol", "dan"]) {
      await tsfga.addTuple({
        objectType: "department_c3b",
        objectId: uuid("finance"),
        relation: "member",
        subjectType: "user_c3b",
        subjectId: uuid(user),
      });
    }

    await tsfga.addTuple({
      objectType: "account_c3b",
      objectId: uuid("ops"),
      relation: "department",
      subjectType: "department_c3b",
      subjectId: uuid("finance"),
    });
    await tsfga.addTuple({
      objectType: "account_c3b",
      objectId: uuid("ops"),
      relation: "owner",
      subjectType: "user_c3b",
      subjectId: uuid("alice"),
    });
    await tsfga.addTuple({
      objectType: "account_c3b",
      objectId: uuid("ops"),
      relation: "viewer",
      subjectType: "user_c3b",
      subjectId: uuid("bob"),
    });

    for (const transfer of ["t1", "t2", "t3"]) {
      await tsfga.addTuple({
        objectType: "transfer_c3b",
        objectId: uuid(transfer),
        relation: "account",
        subjectType: "account_c3b",
        subjectId: uuid("ops"),
      });
    }

    const makers: Array<[string, string]> = [
      ["t1", "bob"],
      ["t2", "carol"],
      ["t3", "dan"],
    ];
    for (const [transfer, user] of makers) {
      await tsfga.addTuple({
        objectType: "transfer_c3b",
        objectId: uuid(transfer),
        relation: "maker",
        subjectType: "user_c3b",
        subjectId: uuid(user),
      });
    }
    for (const transfer of ["t1", "t3"]) {
      await tsfga.addTuple({
        objectType: "transfer_c3b",
        objectId: uuid(transfer),
        relation: "designated_checker",
        subjectType: "department_c3b",
        subjectId: uuid("finance"),
        subjectRelation: "member",
      });
    }
    await tsfga.addTuple({
      objectType: "transfer_c3b",
      objectId: uuid("t1"),
      relation: "auditor",
      subjectType: "user_c3b",
      subjectId: uuid("dan"),
    });
    await tsfga.addTuple({
      objectType: "transfer_c3b",
      objectId: uuid("t2"),
      relation: "designated_checker",
      subjectType: "user_c3b",
      subjectId: uuid("bob"),
    });
    await tsfga.addTuple({
      objectType: "transfer_c3b",
      objectId: uuid("t2"),
      relation: "compliance_hold",
      subjectType: "user_c3b",
      subjectId: "*",
    });

    storeId = await fgaCreateStore("ledger");
    authorizationModelId = await fgaWriteModel(storeId, "./ledger/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./ledger/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
    fgaClient = new OpenFgaClient({
      apiUrl: process.env.FGA_API_URL,
      storeId,
    });
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The department, where the head is a member by union ---

  test("1: the head is a member", async () => {
    await can("department_c3b", "finance", "member", "alice", true);
  });

  test("2: a member is not the head", async () => {
    await can("department_c3b", "finance", "head", "bob", false);
  });

  // --- The first subtraction: a maker is not a checker ---

  test("3: bob is a designated checker of his own transfer", async () => {
    await can("transfer_c3b", "t1", "designated_checker", "bob", true);
  });

  test("4: and is subtracted from the eligible ones", async () => {
    await can("transfer_c3b", "t1", "eligible_checker", "bob", false);
  });

  test("5: carol is eligible", async () => {
    await can("transfer_c3b", "t1", "eligible_checker", "carol", true);
  });

  test("6: so is alice, a member only by being head", async () => {
    await can("transfer_c3b", "t1", "eligible_checker", "alice", true);
  });

  test("7: a stranger is neither", async () => {
    await can("transfer_c3b", "t1", "eligible_checker", "erin", false);
  });

  // --- The second: a wildcard hold ---

  test("8: bob is an eligible checker of t2", async () => {
    await can("transfer_c3b", "t2", "eligible_checker", "bob", true);
  });

  test("9: and the hold takes it back", async () => {
    await can("transfer_c3b", "t2", "can_approve", "bob", false);
  });

  test("10: the hold reaches everyone", async () => {
    await can("transfer_c3b", "t2", "can_approve", "alice", false);
  });

  test("11: t1 has no hold, so approval survives", async () => {
    await can("transfer_c3b", "t1", "can_approve", "carol", true);
    await can("transfer_c3b", "t1", "can_approve", "alice", true);
    await can("transfer_c3b", "t1", "can_approve", "dan", true);
    await can("transfer_c3b", "t1", "can_approve", "bob", false);
  });

  // --- The third: an auditor may approve but not post ---

  test("12: dan may approve t1", async () => {
    await can("transfer_c3b", "t1", "can_approve", "dan", true);
  });

  test("13: and not post it — he audits it", async () => {
    await can("transfer_c3b", "t1", "can_post", "dan", false);
  });

  test("14: carol posts it", async () => {
    await can("transfer_c3b", "t1", "can_post", "carol", true);
  });

  test("15: bob posts nothing he made", async () => {
    await can("transfer_c3b", "t1", "can_post", "bob", false);
  });

  test("16: dan posts t3? no — he made it", async () => {
    await can("transfer_c3b", "t3", "can_post", "dan", false);
  });

  test("17: but bob does, having made neither", async () => {
    await can("transfer_c3b", "t3", "can_post", "bob", true);
  });

  test("18: and dan audits only t1", async () => {
    await can("transfer_c3b", "t3", "auditor", "dan", false);
  });

  // --- The intersection on top of the stack ---

  test("19: alice has dual control of t1", async () => {
    await can("transfer_c3b", "t1", "dual_control", "alice", true);
  });

  test("20: carol may approve t1 but has no account view", async () => {
    await can("account_c3b", "ops", "can_view", "carol", false);
    await can("transfer_c3b", "t1", "dual_control", "carol", false);
  });

  test("21: bob views the account but may not approve t1", async () => {
    await can("account_c3b", "ops", "can_view", "bob", true);
    await can("transfer_c3b", "t1", "dual_control", "bob", false);
  });

  test("22: on t3 bob has both", async () => {
    await can("transfer_c3b", "t3", "dual_control", "bob", true);
  });

  test("23: the hold denies dual control outright", async () => {
    await can("transfer_c3b", "t2", "dual_control", "alice", false);
  });

  // --- Viewing is not approving ---

  test("24: carol views t1 as a designated checker", async () => {
    await can("transfer_c3b", "t1", "can_view", "carol", true);
  });

  test("25: alice views t2 through the account", async () => {
    await can("transfer_c3b", "t2", "can_view", "alice", true);
  });

  test("26: dan does not view t2 at all", async () => {
    await can("transfer_c3b", "t2", "can_view", "dan", false);
  });

  // --- The department userset asked about directly ---

  test("27: the finance userset is an eligible checker of t1", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "transfer_c3b",
        objectId: uuid("t1"),
        relation: "eligible_checker",
        subjectType: "department_c3b",
        subjectId: uuid("finance"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("28: and is held off t2", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "transfer_c3b",
        objectId: uuid("t2"),
        relation: "can_approve",
        subjectType: "department_c3b",
        subjectId: uuid("finance"),
        subjectRelation: "member",
      },
      false,
    );
  });

  // --- listObjects across the exclusion stack ---

  test("29: the transfers alice may approve", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "transfer_c3b",
        relation: "can_approve",
        subjectType: "user_c3b",
        subjectId: uuid("alice"),
      },
      [uuid("t1"), uuid("t3")],
    );
  });

  test("30: the transfers bob may approve", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "transfer_c3b",
        relation: "can_approve",
        subjectType: "user_c3b",
        subjectId: uuid("bob"),
      },
      [uuid("t3")],
    );
  });

  test("31: the transfers dan may post", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "transfer_c3b",
        relation: "can_post",
        subjectType: "user_c3b",
        subjectId: uuid("dan"),
      },
      [],
    );
  });

  test("32: the transfers under alice's dual control", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "transfer_c3b",
        relation: "dual_control",
        subjectType: "user_c3b",
        subjectId: uuid("alice"),
      },
      [uuid("t1"), uuid("t3")],
    );
  });

  // --- The write gate ---

  test("33: a hold is a wildcard, never a person", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "transfer_c3b",
        objectId: uuid("t3"),
        relation: "compliance_hold",
        subjectType: "user_c3b",
        subjectId: uuid("alice"),
      },
      "refused",
    );
  });

  test("34: a maker is a person, never a department", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "transfer_c3b",
        objectId: uuid("t3"),
        relation: "maker",
        subjectType: "department_c3b",
        subjectId: uuid("finance"),
        subjectRelation: "member",
      },
      "refused",
    );
  });

  test("35: a computed exclusion takes no tuple", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "transfer_c3b",
        objectId: uuid("t3"),
        relation: "eligible_checker",
        subjectType: "user_c3b",
        subjectId: uuid("erin"),
      },
      "refused",
    );
  });

  test("36: an auditor may be added", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "transfer_c3b",
        objectId: uuid("t3"),
        relation: "auditor",
        subjectType: "user_c3b",
        subjectId: uuid("bob"),
      },
      "accepted",
    );
  });

  test("37: and immediately loses the right to post", async () => {
    await can("transfer_c3b", "t3", "can_approve", "bob", true);
    await can("transfer_c3b", "t3", "can_post", "bob", false);
    await can("transfer_c3b", "t3", "dual_control", "bob", true);
  });

  // --- Revocation, one subtrahend at a time ---

  test("38: revoking the audit restores posting", async () => {
    await revoke({
      objectType: "transfer_c3b",
      objectId: uuid("t1"),
      relation: "auditor",
      subjectType: "user_c3b",
      subjectId: uuid("dan"),
    });
    await can("transfer_c3b", "t1", "can_post", "dan", true);
  });

  test("39: revoking the hold restores approval", async () => {
    await revoke({
      objectType: "transfer_c3b",
      objectId: uuid("t2"),
      relation: "compliance_hold",
      subjectType: "user_c3b",
      subjectId: "*",
    });
    await can("transfer_c3b", "t2", "can_approve", "bob", true);
    await can("transfer_c3b", "t2", "can_approve", "alice", false);
  });

  test("40: revoking the maker row makes him eligible again", async () => {
    await can("transfer_c3b", "t1", "can_approve", "bob", false);
    await revoke({
      objectType: "transfer_c3b",
      objectId: uuid("t1"),
      relation: "maker",
      subjectType: "user_c3b",
      subjectId: uuid("bob"),
    });
    await can("transfer_c3b", "t1", "eligible_checker", "bob", true);
    await can("transfer_c3b", "t1", "can_approve", "bob", true);
    await can("transfer_c3b", "t1", "can_post", "bob", true);
  });

  test("41: revoking the checker userset empties the relation", async () => {
    await revoke({
      objectType: "transfer_c3b",
      objectId: uuid("t1"),
      relation: "designated_checker",
      subjectType: "department_c3b",
      subjectId: uuid("finance"),
      subjectRelation: "member",
    });
    await can("transfer_c3b", "t1", "can_approve", "alice", false);
    await can("transfer_c3b", "t1", "can_approve", "carol", false);
    await can("transfer_c3b", "t1", "dual_control", "alice", false);
    await can("transfer_c3b", "t1", "can_view", "alice", true);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./ledger/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
