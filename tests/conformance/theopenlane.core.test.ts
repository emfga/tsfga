import { afterAll, beforeAll, describe, test } from "bun:test";
import type { TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  type FixtureRecord,
} from "./helpers/conformance.ts";
import {
  setupTheopenlane,
  teardownTheopenlane,
  uuid,
} from "./theopenlane/setup.ts";

// Tests 21 representative types covering all 6 authorization patterns:
// A) Exclusion in union (program, control, campaign, etc.)
// B) Intersection in union (organization can_edit)
// C) Intersection + TTU (audit_log_viewer)
// D) Contact intersection in union
// E) Evidence nested exclusion
// F) Program intersection with TTU (admin, member)

describe("TheOpenLane — Core", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    ({ db, storeId, authorizationModelId, tsfgaClient, fixture } =
      await setupTheopenlane());
  });

  afterAll(async () => {
    await teardownTheopenlane(db);
  });

  // --- Group 1: User & Service — computed userset ---
  test("1: alice can_view user:alice (self)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "user",
        objectId: uuid("alice"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("2: bob cannot can_view user:alice", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "user",
        objectId: uuid("alice"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });
  test("3: svc_api can_view service:svc_api (self)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "service",
        objectId: uuid("svc_api"),
        relation: "can_view",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });

  // --- Group 2: System & Feature ---
  test("4: alice system_admin sys_main", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "system",
        objectId: uuid("sys_main"),
        relation: "system_admin",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("5: svc_api system_admin sys_main", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "system",
        objectId: uuid("sys_main"),
        relation: "system_admin",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });
  test("6: bob not system_admin sys_main", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "system",
        objectId: uuid("sys_main"),
        relation: "system_admin",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });
  test("7: acme enabled feat_sso", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("feat_sso"),
        relation: "enabled",
        subjectType: "organization",
        subjectId: uuid("acme"),
      },
      true,
    );
  });

  // --- Group 3: Organization — core access ---
  test("8: alice can_edit acme (owner bypasses intersection)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("9: bob can_edit acme (admin ∩ access)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("10: bob cannot can_edit acme (wrong domain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { email_domain: "evil.com" },
      },
      false,
    );
  });
  test("11: charlie can_view acme (member ∩ access)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("12: charlie cannot can_view acme (wrong domain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "evil.com" },
      },
      false,
    );
  });
  test("13: diana cannot can_view acme (not member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });
  test("14: svc_api can_edit acme (service direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_edit",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });
  test("15: alice can_delete acme (owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("16: bob cannot can_delete acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });
  test("17: bob can_view subsidiary (parent chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("subsidiary"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });

  // --- Group 4: Organization — creators ---
  test("18: charlie can_create_standard acme (editors_grp member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_create_standard",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("19: charlie can_create_group acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_create_group",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("20: eve cannot can_create_standard acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_create_standard",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });
  test("21: alice can_create_standard acme (owner → can_edit)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_create_standard",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("22: alice can_manage_trust_center acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_manage_trust_center",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("23: charlie cannot can_manage_trust_center acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_manage_trust_center",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });

  // --- Group 5: Organization — audit & invite ---
  test("24: alice audit_log_viewer acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "audit_log_viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("25: diana cannot audit_log_viewer acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "audit_log_viewer",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });
  test("26: charlie can_invite_members acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_invite_members",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("27: charlie cannot can_invite_admins acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_invite_admins",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });

  // --- Group 6: Organization — time_based_grant ---
  test("28: alice can_view acme (within time window)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { current_time: "2025-01-01T00:30:00Z" },
      },
      true,
    );
  });
  test("29: alice can_view acme even past time window (owner path)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { current_time: "2025-01-01T02:00:00Z" },
      },
      true,
    );
  });
  test("30: svc_api can_view acme (service direct via can_edit)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });

  // --- Group 7: Group — public_group condition ---
  test("31: eve can_view engineering (member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("32: alice can_edit engineering (admin)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("33: charlie can_view engineering (parent_viewer, public)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { public: true, email_domain: "acme.com" },
      },
      true,
    );
  });
  test("34: diana cannot can_view engineering (not org member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { public: true, email_domain: "acme.com" },
      },
      false,
    );
  });
  test("35: alice audit_log_viewer engineering (public)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "audit_log_viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { public: true, email_domain: "acme.com" },
      },
      true,
    );
  });
  test("36: frank can_view engineering (member, not blocked on group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      true,
    );
  });

  // --- Group 8: File — wildcards & chains ---
  test("37: diana can_view file_logo (wildcard)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "file",
        objectId: uuid("file_logo"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });
  test("38: alice can_edit file_logo (parent_editor via org)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "file",
        objectId: uuid("file_logo"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("39: eve can_view file_ctrl (parent_viewer via ctrl)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "file",
        objectId: uuid("file_ctrl"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("40: diana can_view file_ctrl (NDA chain via tc_doc)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "file",
        objectId: uuid("file_ctrl"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });
  test("41: diana cannot can_edit file_ctrl", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "file",
        objectId: uuid("file_ctrl"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // Asserted once for the whole model rather than in all three
  // TheOpenLane files: every one of them writes the same 225
  // configs through the same setup.
  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./theopenlane/model.dsl", fixture, {
      // The model defines 632 relations across 67 types; this
      // fixture configures 225 of them on purpose. What it does
      // configure must still be right, and any relation a tuple
      // targets must be configured at all.
      coverage: "subset",
      // Relations tsfga needs and the DSL has no name for, each
      // decomposing a shape the check algorithm has no single form
      // for. Every one is asserted to be absent from the model.
      tsfgaOnlyHelpers: [
        "organization._admin_and_access",
        "organization._member_and_access",
        "program._editor_not_blocked",
        "program._editor_or_viewer_not_blocked",
        "control._editor_not_blocked",
        "control._viewer_not_blocked",
        "subcontrol._editor_not_blocked",
        "subcontrol._viewer_not_blocked",
        "internal_policy._editor_not_blocked",
        "internal_policy._viewer_not_blocked",
        "contact._direct_and_parent_member_view",
        "contact._direct_and_parent_member_edit",
        "contact._direct_user_and_parent_member",
        "contact._editor_not_blocked",
        "contact._viewer_not_blocked",
        "evidence._delete_not_blocked",
        "evidence._edit_not_blocked",
        "evidence._view_not_blocked",
        "workflow_definition._editor_not_blocked",
        "workflow_definition._viewer_not_blocked",
        "workflow_instance._viewer_not_blocked",
        "assessment._editor_not_blocked",
        "assessment._viewer_not_blocked",
        "campaign._editor_not_blocked",
        "campaign._viewer_not_blocked",
      ],
      // The three relations whose direct assignment tsfga cannot
      // express alongside their intersection, so it lives on a
      // helper. Naming the destination makes the exemption
      // checkable: the helper must admit everything the model gave
      // the original, and the original must now admit nothing.
      moved: [
        {
          relation: "contact.can_view",
          movedTo: "contact._direct_and_parent_member_view",
        },
        {
          relation: "contact.can_edit",
          movedTo: "contact._direct_and_parent_member_edit",
        },
        {
          relation: "contact.can_delete",
          movedTo: "contact._direct_user_and_parent_member",
        },
      ],
    });
  });
});
