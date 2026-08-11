import {
  type AddTupleRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
import { type DB, KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { type FixtureRecord, recordFixture } from "../helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "../helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "../helpers/openfga.ts";

// Ref: TheOpenLane authorization model
// https://github.com/theopenlane/core/blob/b678367/fga/model/model.fga

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-c200-000000000001"],
  ["bob", "00000000-0000-4000-c200-000000000002"],
  ["charlie", "00000000-0000-4000-c200-000000000003"],
  ["diana", "00000000-0000-4000-c200-000000000004"],
  ["eve", "00000000-0000-4000-c200-000000000005"],
  ["frank", "00000000-0000-4000-c200-000000000006"],
  ["grace", "00000000-0000-4000-c200-000000000007"],
  ["henry", "00000000-0000-4000-c200-000000000008"],
  ["svc_api", "00000000-0000-4000-c200-000000000009"],
  ["svc_monitor", "00000000-0000-4000-c200-00000000000a"],
  ["acme", "00000000-0000-4000-c200-00000000000b"],
  ["subsidiary", "00000000-0000-4000-c200-00000000000c"],
  ["engineering", "00000000-0000-4000-c200-00000000000d"],
  ["editors_grp", "00000000-0000-4000-c200-00000000000e"],
  ["auditors_grp", "00000000-0000-4000-c200-00000000000f"],
  ["sys_main", "00000000-0000-4000-c200-000000000010"],
  ["feat_sso", "00000000-0000-4000-c200-000000000011"],
  ["prog_compliance", "00000000-0000-4000-c200-000000000012"],
  ["ctrl_soc2", "00000000-0000-4000-c200-000000000013"],
  ["sub_access", "00000000-0000-4000-c200-000000000014"],
  ["policy_data", "00000000-0000-4000-c200-000000000015"],
  ["contact_vendor", "00000000-0000-4000-c200-000000000016"],
  ["task_review", "00000000-0000-4000-c200-000000000017"],
  ["note_ctrl", "00000000-0000-4000-c200-000000000018"],
  ["evidence_doc", "00000000-0000-4000-c200-000000000019"],
  ["std_iso", "00000000-0000-4000-c200-00000000001a"],
  ["tc_acme", "00000000-0000-4000-c200-00000000001b"],
  ["tc_doc_public", "00000000-0000-4000-c200-00000000001c"],
  ["tc_doc_private", "00000000-0000-4000-c200-00000000001d"],
  ["export_data", "00000000-0000-4000-c200-00000000001e"],
  ["file_logo", "00000000-0000-4000-c200-00000000001f"],
  ["file_ctrl", "00000000-0000-4000-c200-000000000020"],
  ["wf_def", "00000000-0000-4000-c200-000000000021"],
  ["wf_instance", "00000000-0000-4000-c200-000000000022"],
  ["assess_q1", "00000000-0000-4000-c200-000000000023"],
  ["camp_onboard", "00000000-0000-4000-c200-000000000024"],
]);

export const WILDCARD = "*";

export function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/**
 * Shorthand for a `RelationConfig`, defaulting the rewrite fields
 * to `null`.
 *
 * `directlyAssignable` is deliberately **not** among them. It
 * defaulted to `["user", "user:*"]`, which is the most permissive
 * value there is, and 70 of the 225 configs here took it silently —
 * 45 of them on relations this model gives no direct assignment at
 * all. A default cannot be right for a field whose whole job is to
 * say what a relation admits, so every config states it.
 */
function rc(
  partial: Partial<RelationConfig> &
    Pick<RelationConfig, "objectType" | "relation" | "directlyAssignable">,
): RelationConfig {
  return {
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...partial,
  };
}

// === Condition definitions ===

const CONDITION_DEFS = [
  {
    name: "public_group",
    expression: "public == true",
    parameters: { public: "bool" as const },
  },
  {
    name: "time_based_grant",
    expression: "current_time < grant_time + grant_duration",
    parameters: {
      current_time: "timestamp" as const,
      grant_time: "timestamp" as const,
      grant_duration: "duration" as const,
    },
  },
  {
    name: "email_domains_allowed",
    expression:
      'allowed_domains == [] || email_domain == "" || email_domain in allowed_domains',
    parameters: {
      email_domain: "string" as const,
      allowed_domains: "list<string>" as const,
    },
  },
] as const;

// === Relation configs ===

const RELATION_CONFIGS: RelationConfig[] = [
  // --- user ---
  rc({
    objectType: "user",
    relation: "_self",
    directlyAssignable: [{ type: "user" }],
  }),
  rc({
    objectType: "user",
    relation: "can_view",
    directlyAssignable: [],
    computedUserset: "_self",
  }),
  rc({
    objectType: "user",
    relation: "can_edit",
    directlyAssignable: [],
    computedUserset: "_self",
  }),
  rc({
    objectType: "user",
    relation: "can_delete",
    directlyAssignable: [],
    computedUserset: "_self",
  }),
  // --- service ---
  rc({
    objectType: "service",
    relation: "_self",
    directlyAssignable: [{ type: "service" }],
  }),
  rc({
    objectType: "service",
    relation: "can_view",
    directlyAssignable: [],
    computedUserset: "_self",
  }),
  rc({
    objectType: "service",
    relation: "can_edit",
    directlyAssignable: [],
    computedUserset: "_self",
  }),
  rc({
    objectType: "service",
    relation: "can_delete",
    directlyAssignable: [],
    computedUserset: "_self",
  }),
  // --- system ---
  rc({
    objectType: "system",
    relation: "system_admin",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
  }),
  // --- feature ---
  rc({
    objectType: "feature",
    relation: "enabled",
    directlyAssignable: [{ type: "organization" }],
  }),
  // --- organization ---
  rc({
    objectType: "organization",
    relation: "parent",
    directlyAssignable: [{ type: "organization" }],
  }),
  rc({
    objectType: "organization",
    relation: "owner",
    directlyAssignable: [{ type: "user" }],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
  }),
  rc({
    objectType: "organization",
    relation: "admin",
    directlyAssignable: [{ type: "user" }],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "admin" }],
  }),
  rc({
    objectType: "organization",
    relation: "member",
    directlyAssignable: [{ type: "user" }],
    impliedBy: ["owner", "admin"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
  }),
  rc({
    objectType: "organization",
    relation: "access",
    directlyAssignable: [
      {
        type: "organization",
        relation: "member",
        condition: "email_domains_allowed",
      },
    ],
  }),
  rc({
    objectType: "organization",
    relation: "_admin_and_access",
    directlyAssignable: [],
    intersection: [
      { type: "computedUserset", relation: "admin" },
      { type: "computedUserset", relation: "access" },
    ],
  }),
  rc({
    objectType: "organization",
    relation: "can_delete",
    directlyAssignable: [{ type: "service" }],
    impliedBy: ["owner"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
  }),
  rc({
    objectType: "organization",
    relation: "can_edit",
    directlyAssignable: [{ type: "service" }],
    impliedBy: ["_admin_and_access", "owner"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
  }),
  rc({
    objectType: "organization",
    relation: "_member_and_access",
    directlyAssignable: [],
    intersection: [
      { type: "computedUserset", relation: "member" },
      { type: "computedUserset", relation: "access" },
    ],
  }),
  rc({
    objectType: "organization",
    relation: "can_view",
    directlyAssignable: [
      { type: "service" },
      { type: "user", condition: "time_based_grant" },
    ],
    impliedBy: ["_member_and_access", "owner", "can_edit"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "organization",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["owner"],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  rc({
    objectType: "organization",
    relation: "can_invite_members",
    directlyAssignable: [],
    impliedBy: ["can_view", "can_edit"],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "can_invite_members" },
    ],
  }),
  rc({
    objectType: "organization",
    relation: "can_invite_admins",
    directlyAssignable: [],
    impliedBy: ["can_edit"],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "can_invite_admins" },
    ],
  }),
  rc({
    objectType: "organization",
    relation: "standard_creator",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "organization",
    relation: "can_create_standard",
    directlyAssignable: [],
    impliedBy: ["can_edit", "standard_creator"],
  }),
  rc({
    objectType: "organization",
    relation: "group_creator",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "organization",
    relation: "can_create_group",
    directlyAssignable: [],
    impliedBy: ["can_edit", "group_creator"],
  }),
  rc({
    objectType: "organization",
    relation: "trust_center_admin",
    directlyAssignable: [{ type: "user" }],
  }),
  rc({
    objectType: "organization",
    relation: "can_manage_trust_center",
    directlyAssignable: [],
    impliedBy: ["trust_center_admin", "owner"],
  }),
  // --- group ---
  rc({
    objectType: "group",
    relation: "admin",
    directlyAssignable: [{ type: "user" }],
  }),
  rc({
    objectType: "group",
    relation: "member",
    directlyAssignable: [{ type: "user" }],
    impliedBy: ["admin"],
  }),
  rc({
    objectType: "group",
    relation: "parent",
    directlyAssignable: [{ type: "organization", condition: "public_group" }],
  }),
  rc({
    objectType: "group",
    relation: "parent_admin",
    directlyAssignable: [{ type: "organization", relation: "owner" }],
  }),
  rc({
    objectType: "group",
    relation: "parent_viewer",
    directlyAssignable: [],
    impliedBy: ["parent_admin"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "group",
    relation: "parent_editor",
    directlyAssignable: [],
    impliedBy: ["parent_admin"],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "can_manage_groups" },
    ],
  }),
  rc({
    objectType: "group",
    relation: "parent_deleter",
    directlyAssignable: [],
    impliedBy: ["parent_admin"],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "can_manage_groups" },
    ],
  }),
  rc({
    objectType: "group",
    relation: "can_delete",
    directlyAssignable: [{ type: "service" }],
    impliedBy: ["admin", "parent_deleter"],
  }),
  rc({
    objectType: "group",
    relation: "can_edit",
    directlyAssignable: [{ type: "service" }],
    impliedBy: ["admin", "parent_editor"],
  }),
  rc({
    objectType: "group",
    relation: "can_view",
    directlyAssignable: [{ type: "service" }],
    impliedBy: ["can_edit", "member", "parent_viewer"],
  }),
  rc({
    objectType: "group",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- file ---
  rc({
    objectType: "file",
    relation: "parent",
    directlyAssignable: [
      { type: "user" },
      { type: "program" },
      { type: "organization" },
      { type: "control" },
      { type: "procedure" },
      { type: "template" },
      { type: "document_data" },
      { type: "contact" },
      { type: "internal_policy" },
      { type: "narrative" },
      { type: "evidence" },
      { type: "note" },
      { type: "trust_center_setting" },
      { type: "subprocessor" },
      { type: "export" },
      { type: "trust_center_watermark_config" },
      { type: "standard" },
      { type: "trust_center_entity" },
    ],
  }),
  rc({
    objectType: "file",
    relation: "tc_doc_parent",
    directlyAssignable: [{ type: "trust_center_doc" }],
  }),
  rc({
    objectType: "file",
    relation: "parent_viewer",
    directlyAssignable: [],
    impliedBy: ["can_delete", "can_edit"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "file",
    relation: "parent_editor",
    directlyAssignable: [],
    impliedBy: ["can_delete"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
  }),
  rc({
    objectType: "file",
    relation: "parent_deleter",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
  }),
  rc({
    objectType: "file",
    relation: "tc_doc_viewer",
    directlyAssignable: [],
    tupleToUserset: [
      { tupleset: "tc_doc_parent", computedUserset: "nda_signed" },
      { tupleset: "tc_doc_parent", computedUserset: "member" },
    ],
  }),
  rc({
    objectType: "file",
    relation: "tc_doc_editor",
    directlyAssignable: [],
    tupleToUserset: [
      { tupleset: "tc_doc_parent", computedUserset: "can_edit" },
    ],
  }),
  rc({
    objectType: "file",
    relation: "tc_doc_deleter",
    directlyAssignable: [],
    tupleToUserset: [
      { tupleset: "tc_doc_parent", computedUserset: "can_delete" },
    ],
  }),
  rc({
    objectType: "file",
    relation: "can_view",
    directlyAssignable: [
      { type: "user", wildcard: true },
      { type: "service", wildcard: true },
      { type: "user" },
      { type: "service" },
      { type: "organization", relation: "member" },
    ],
    impliedBy: ["parent_viewer", "tc_doc_viewer"],
  }),
  rc({
    objectType: "file",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["parent_editor", "tc_doc_editor"],
  }),
  rc({
    objectType: "file",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["parent_deleter", "tc_doc_deleter"],
  }),
  rc({
    objectType: "file",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- program ---
  rc({
    objectType: "program",
    relation: "parent",
    directlyAssignable: [{ type: "organization" }],
  }),
  rc({
    objectType: "program",
    relation: "admin",
    directlyAssignable: [{ type: "user" }],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
    intersection: [
      { type: "direct" },
      { type: "tupleToUserset", tupleset: "parent", computedUserset: "member" },
    ],
  }),
  rc({
    objectType: "program",
    relation: "member",
    directlyAssignable: [{ type: "user" }],
    intersection: [
      { type: "direct" },
      { type: "tupleToUserset", tupleset: "parent", computedUserset: "member" },
    ],
  }),
  rc({
    objectType: "program",
    relation: "auditor",
    directlyAssignable: [{ type: "user" }],
  }),
  rc({
    objectType: "program",
    relation: "editor",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "program",
    relation: "viewer",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "program",
    relation: "blocked",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "program",
    relation: "parent_viewer",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
  }),
  rc({
    objectType: "program",
    relation: "parent_editor",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
  }),
  rc({
    objectType: "program",
    relation: "parent_deleter",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
  }),
  rc({
    objectType: "program",
    relation: "_editor_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "program",
    relation: "_editor_or_viewer_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor", "viewer"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "program",
    relation: "can_delete",
    directlyAssignable: [{ type: "service" }],
    impliedBy: ["admin", "parent_deleter"],
  }),
  rc({
    objectType: "program",
    relation: "can_edit",
    directlyAssignable: [{ type: "service" }],
    impliedBy: ["admin", "parent_editor", "_editor_not_blocked"],
  }),
  rc({
    objectType: "program",
    relation: "can_view",
    directlyAssignable: [{ type: "service" }],
    impliedBy: [
      "member",
      "can_edit",
      "parent_viewer",
      "_editor_or_viewer_not_blocked",
    ],
  }),
  rc({
    objectType: "program",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["admin"],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  rc({
    objectType: "program",
    relation: "can_invite_members",
    directlyAssignable: [],
    impliedBy: ["member", "can_edit"],
  }),
  rc({
    objectType: "program",
    relation: "can_invite_admins",
    directlyAssignable: [],
    computedUserset: "can_edit",
  }),
  // --- control ---
  rc({
    objectType: "control",
    relation: "parent",
    directlyAssignable: [
      { type: "user" },
      { type: "service" },
      { type: "organization" },
      { type: "program" },
      { type: "standard" },
    ],
  }),
  rc({
    objectType: "control",
    relation: "system",
    directlyAssignable: [{ type: "system" }],
  }),
  rc({
    objectType: "control",
    relation: "owner",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "control",
    relation: "delegate",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "control",
    relation: "blocked",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "control",
    relation: "viewer",
    directlyAssignable: [],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "member" },
      { tupleset: "parent", computedUserset: "can_view" },
    ],
  }),
  rc({
    objectType: "control",
    relation: "editor",
    directlyAssignable: [
      { type: "group", relation: "member" },
      { type: "organization", relation: "owner" },
    ],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "admin" },
      { tupleset: "parent", computedUserset: "can_edit" },
    ],
  }),
  rc({
    objectType: "control",
    relation: "_editor_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "control",
    relation: "_viewer_not_blocked",
    directlyAssignable: [],
    impliedBy: ["viewer"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "control",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["owner", "_editor_not_blocked"],
    tupleToUserset: [{ tupleset: "system", computedUserset: "system_admin" }],
  }),
  rc({
    objectType: "control",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["owner", "delegate", "_editor_not_blocked"],
    tupleToUserset: [{ tupleset: "system", computedUserset: "system_admin" }],
  }),
  rc({
    objectType: "control",
    relation: "can_view",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["can_edit", "_viewer_not_blocked"],
  }),
  rc({
    objectType: "control",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- subcontrol ---
  rc({
    objectType: "subcontrol",
    relation: "parent",
    directlyAssignable: [
      { type: "user" },
      { type: "service" },
      { type: "control" },
    ],
  }),
  rc({
    objectType: "subcontrol",
    relation: "owner",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "subcontrol",
    relation: "delegate",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "subcontrol",
    relation: "blocked",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "subcontrol",
    relation: "viewer",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "subcontrol",
    relation: "editor",
    directlyAssignable: [
      { type: "group", relation: "member" },
      { type: "organization", relation: "owner" },
    ],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
  }),
  rc({
    objectType: "subcontrol",
    relation: "_editor_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "subcontrol",
    relation: "_viewer_not_blocked",
    directlyAssignable: [],
    impliedBy: ["viewer"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "subcontrol",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["owner", "_editor_not_blocked"],
  }),
  rc({
    objectType: "subcontrol",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["owner", "delegate", "_editor_not_blocked"],
  }),
  rc({
    objectType: "subcontrol",
    relation: "can_view",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["can_edit", "_viewer_not_blocked"],
  }),
  rc({
    objectType: "subcontrol",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- internal_policy ---
  rc({
    objectType: "internal_policy",
    relation: "parent",
    directlyAssignable: [{ type: "organization" }],
  }),
  rc({
    objectType: "internal_policy",
    relation: "admin",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
  }),
  rc({
    objectType: "internal_policy",
    relation: "editor",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "internal_policy",
    relation: "viewer",
    directlyAssignable: [
      { type: "program", relation: "auditor" },
      { type: "group", relation: "member" },
    ],
    impliedBy: ["editor"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "internal_policy",
    relation: "blocked",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "internal_policy",
    relation: "approver",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "internal_policy",
    relation: "delegate",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "internal_policy",
    relation: "_editor_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "internal_policy",
    relation: "_viewer_not_blocked",
    directlyAssignable: [],
    impliedBy: ["viewer"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "internal_policy",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["admin", "approver", "_editor_not_blocked"],
  }),
  rc({
    objectType: "internal_policy",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["admin", "approver", "delegate", "_editor_not_blocked"],
  }),
  rc({
    objectType: "internal_policy",
    relation: "can_view",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["can_edit", "_viewer_not_blocked"],
  }),
  rc({
    objectType: "internal_policy",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- contact ---
  rc({
    objectType: "contact",
    relation: "parent",
    directlyAssignable: [{ type: "organization" }],
  }),
  rc({
    objectType: "contact",
    relation: "editor",
    directlyAssignable: [{ type: "group", relation: "member" }],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
  }),
  rc({
    objectType: "contact",
    relation: "viewer",
    directlyAssignable: [{ type: "group", relation: "member" }],
    impliedBy: ["editor"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "contact",
    relation: "blocked",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "contact",
    relation: "_direct_and_parent_member_view",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    intersection: [
      { type: "direct" },
      { type: "tupleToUserset", tupleset: "parent", computedUserset: "member" },
    ],
  }),
  rc({
    objectType: "contact",
    relation: "_direct_and_parent_member_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    intersection: [
      { type: "direct" },
      { type: "tupleToUserset", tupleset: "parent", computedUserset: "member" },
    ],
  }),
  rc({
    objectType: "contact",
    relation: "_direct_user_and_parent_member",
    directlyAssignable: [{ type: "user" }],
    intersection: [
      { type: "direct" },
      { type: "tupleToUserset", tupleset: "parent", computedUserset: "member" },
    ],
  }),
  rc({
    objectType: "contact",
    relation: "_editor_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "contact",
    relation: "_viewer_not_blocked",
    directlyAssignable: [],
    impliedBy: ["viewer"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "contact",
    relation: "can_view",
    directlyAssignable: [],
    impliedBy: [
      "can_edit",
      "_viewer_not_blocked",
      "_direct_and_parent_member_view",
    ],
  }),
  rc({
    objectType: "contact",
    relation: "can_edit",
    directlyAssignable: [],
    impliedBy: ["_editor_not_blocked", "_direct_and_parent_member_edit"],
  }),
  rc({
    objectType: "contact",
    relation: "can_delete",
    directlyAssignable: [],
    impliedBy: ["_editor_not_blocked", "_direct_user_and_parent_member"],
  }),
  rc({
    objectType: "contact",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- task ---
  rc({
    objectType: "task",
    relation: "parent",
    directlyAssignable: [
      { type: "user" },
      { type: "service" },
      { type: "program" },
      { type: "control" },
      { type: "procedure" },
      { type: "internal_policy" },
      { type: "subcontrol" },
      { type: "control_objective" },
      { type: "risk" },
      { type: "task" },
    ],
  }),
  rc({
    objectType: "task",
    relation: "assignee",
    directlyAssignable: [{ type: "user" }],
  }),
  rc({
    objectType: "task",
    relation: "assigner",
    directlyAssignable: [{ type: "user" }],
  }),
  rc({
    objectType: "task",
    relation: "viewer",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "task",
    relation: "editor",
    directlyAssignable: [{ type: "organization", relation: "owner" }],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
  }),
  rc({
    objectType: "task",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["assigner"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
  }),
  rc({
    objectType: "task",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["assignee", "assigner", "editor", "can_delete"],
  }),
  rc({
    objectType: "task",
    relation: "can_view",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["assignee", "assigner", "can_delete", "can_edit", "viewer"],
  }),
  rc({
    objectType: "task",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- note ---
  rc({
    objectType: "note",
    relation: "parent",
    directlyAssignable: [
      { type: "program" },
      { type: "control" },
      { type: "procedure" },
      { type: "internal_policy" },
      { type: "subcontrol" },
      { type: "control_objective" },
      { type: "task" },
      { type: "trust_center" },
      { type: "risk" },
      { type: "evidence" },
      { type: "discussion" },
    ],
  }),
  rc({
    objectType: "note",
    relation: "owner",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
  }),
  rc({
    objectType: "note",
    relation: "editor",
    directlyAssignable: [{ type: "organization", relation: "owner" }],
  }),
  rc({
    objectType: "note",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["owner", "editor"],
  }),
  rc({
    objectType: "note",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["can_edit"],
  }),
  rc({
    objectType: "note",
    relation: "can_view",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["can_edit"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "note",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- evidence ---
  rc({
    objectType: "evidence",
    relation: "parent",
    directlyAssignable: [
      { type: "user" },
      { type: "service" },
      { type: "program" },
      { type: "control" },
      { type: "procedure" },
      { type: "internal_policy" },
      { type: "subcontrol" },
      { type: "control_objective" },
      { type: "task" },
    ],
  }),
  rc({
    objectType: "evidence",
    relation: "editor",
    directlyAssignable: [
      { type: "group", relation: "member" },
      { type: "organization", relation: "owner" },
    ],
  }),
  rc({
    objectType: "evidence",
    relation: "viewer",
    directlyAssignable: [{ type: "group", relation: "member" }],
    impliedBy: ["editor"],
  }),
  rc({
    objectType: "evidence",
    relation: "blocked",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "evidence",
    relation: "_delete_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "evidence",
    relation: "_edit_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "evidence",
    relation: "_view_not_blocked",
    directlyAssignable: [],
    impliedBy: ["viewer"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "evidence",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["_delete_not_blocked"],
  }),
  rc({
    objectType: "evidence",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["can_delete", "_edit_not_blocked"],
  }),
  rc({
    objectType: "evidence",
    relation: "can_view",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["can_edit", "_view_not_blocked"],
  }),
  rc({
    objectType: "evidence",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- standard ---
  rc({
    objectType: "standard",
    relation: "parent",
    directlyAssignable: [{ type: "organization" }],
  }),
  rc({
    objectType: "standard",
    relation: "associated_with",
    directlyAssignable: [{ type: "trust_center" }],
  }),
  rc({
    objectType: "standard",
    relation: "editor",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
  }),
  rc({
    objectType: "standard",
    relation: "viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["editor"],
    tupleToUserset: [
      { tupleset: "associated_with", computedUserset: "can_view" },
    ],
  }),
  rc({
    objectType: "standard",
    relation: "parent_viewer",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
  }),
  rc({
    objectType: "standard",
    relation: "parent_editor",
    directlyAssignable: [],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "admin" },
      { tupleset: "parent", computedUserset: "owner" },
    ],
  }),
  rc({
    objectType: "standard",
    relation: "can_view",
    directlyAssignable: [
      { type: "user", wildcard: true },
      { type: "service", wildcard: true },
    ],
    impliedBy: ["viewer", "parent_viewer"],
  }),
  rc({
    objectType: "standard",
    relation: "can_edit",
    directlyAssignable: [],
    impliedBy: ["editor", "parent_editor"],
  }),
  rc({
    objectType: "standard",
    relation: "can_delete",
    directlyAssignable: [],
    impliedBy: ["editor", "parent_editor"],
  }),
  rc({
    objectType: "standard",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- trust_center ---
  rc({
    objectType: "trust_center",
    relation: "parent",
    directlyAssignable: [{ type: "organization" }],
  }),
  rc({
    objectType: "trust_center",
    relation: "system",
    directlyAssignable: [{ type: "system" }],
  }),
  rc({
    objectType: "trust_center",
    relation: "nda_signed",
    directlyAssignable: [{ type: "user" }],
  }),
  rc({
    objectType: "trust_center",
    relation: "editor",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "trust_center",
    relation: "viewer",
    directlyAssignable: [],
    computedUserset: "editor",
  }),
  rc({
    objectType: "trust_center",
    relation: "member",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
  }),
  rc({
    objectType: "trust_center",
    relation: "parent_viewer",
    directlyAssignable: [],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "can_edit" },
      { tupleset: "parent", computedUserset: "can_view" },
    ],
  }),
  rc({
    objectType: "trust_center",
    relation: "parent_editor",
    directlyAssignable: [],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "can_edit" },
      { tupleset: "parent", computedUserset: "can_manage_trust_center" },
    ],
  }),
  rc({
    objectType: "trust_center",
    relation: "parent_deleter",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
  }),
  rc({
    objectType: "trust_center",
    relation: "can_view",
    directlyAssignable: [
      { type: "user", wildcard: true },
      { type: "service", wildcard: true },
    ],
    impliedBy: ["parent_viewer", "viewer"],
  }),
  rc({
    objectType: "trust_center",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["parent_editor", "editor"],
    tupleToUserset: [{ tupleset: "system", computedUserset: "system_admin" }],
  }),
  rc({
    objectType: "trust_center",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["parent_deleter"],
  }),
  // --- trust_center_doc ---
  rc({
    objectType: "trust_center_doc",
    relation: "parent",
    directlyAssignable: [
      { type: "trust_center" },
      { type: "user" },
      { type: "service" },
    ],
  }),
  rc({
    objectType: "trust_center_doc",
    relation: "editor",
    directlyAssignable: [{ type: "group", relation: "member" }],
  }),
  rc({
    objectType: "trust_center_doc",
    relation: "viewer",
    directlyAssignable: [],
    computedUserset: "editor",
  }),
  rc({
    objectType: "trust_center_doc",
    relation: "nda_signed",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "nda_signed" }],
  }),
  rc({
    objectType: "trust_center_doc",
    relation: "member",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
  }),
  rc({
    objectType: "trust_center_doc",
    relation: "parent_viewer",
    directlyAssignable: [],
    impliedBy: ["can_delete", "can_edit"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
  }),
  rc({
    objectType: "trust_center_doc",
    relation: "parent_editor",
    directlyAssignable: [],
    impliedBy: ["can_delete"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
  }),
  rc({
    objectType: "trust_center_doc",
    relation: "parent_deleter",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
  }),
  rc({
    objectType: "trust_center_doc",
    relation: "can_view",
    directlyAssignable: [
      { type: "user" },
      { type: "service" },
      { type: "user", wildcard: true },
      { type: "service", wildcard: true },
    ],
    impliedBy: ["parent_viewer", "viewer"],
  }),
  rc({
    objectType: "trust_center_doc",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["parent_editor", "editor"],
  }),
  rc({
    objectType: "trust_center_doc",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["parent_deleter", "editor"],
  }),
  // --- export ---
  rc({
    objectType: "export",
    relation: "system",
    directlyAssignable: [{ type: "system" }],
  }),
  rc({
    objectType: "export",
    relation: "can_delete",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "system", computedUserset: "system_admin" }],
  }),
  rc({
    objectType: "export",
    relation: "can_edit",
    directlyAssignable: [{ type: "service" }],
    tupleToUserset: [{ tupleset: "system", computedUserset: "system_admin" }],
  }),
  rc({
    objectType: "export",
    relation: "can_view",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["can_edit"],
  }),
  // --- workflow_definition ---
  rc({
    objectType: "workflow_definition",
    relation: "parent",
    directlyAssignable: [
      { type: "user" },
      { type: "service" },
      { type: "organization" },
    ],
  }),
  rc({
    objectType: "workflow_definition",
    relation: "admin",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
  }),
  rc({
    objectType: "workflow_definition",
    relation: "editor",
    directlyAssignable: [
      { type: "group", relation: "member" },
      { type: "organization", relation: "owner" },
    ],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
  }),
  rc({
    objectType: "workflow_definition",
    relation: "viewer",
    directlyAssignable: [{ type: "group", relation: "member" }],
    impliedBy: ["editor"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "workflow_definition",
    relation: "blocked",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "workflow_definition",
    relation: "_editor_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "workflow_definition",
    relation: "_viewer_not_blocked",
    directlyAssignable: [],
    impliedBy: ["viewer"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "workflow_definition",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["admin", "_editor_not_blocked"],
  }),
  rc({
    objectType: "workflow_definition",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["admin", "_editor_not_blocked"],
  }),
  rc({
    objectType: "workflow_definition",
    relation: "can_view",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["can_edit", "_viewer_not_blocked"],
  }),
  rc({
    objectType: "workflow_definition",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- workflow_instance ---
  rc({
    objectType: "workflow_instance",
    relation: "parent",
    directlyAssignable: [
      { type: "user" },
      { type: "service" },
      { type: "organization" },
      { type: "workflow_definition" },
      { type: "control" },
      { type: "internal_policy" },
      { type: "evidence" },
    ],
  }),
  rc({
    objectType: "workflow_instance",
    relation: "viewer",
    directlyAssignable: [],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "workflow_instance",
    relation: "blocked",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "workflow_instance",
    relation: "_viewer_not_blocked",
    directlyAssignable: [],
    impliedBy: ["viewer"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "workflow_instance",
    relation: "can_view",
    directlyAssignable: [{ type: "service" }],
    impliedBy: ["_viewer_not_blocked"],
  }),
  rc({
    objectType: "workflow_instance",
    relation: "can_edit",
    directlyAssignable: [{ type: "service" }],
  }),
  rc({
    objectType: "workflow_instance",
    relation: "can_delete",
    directlyAssignable: [{ type: "service" }],
  }),
  rc({
    objectType: "workflow_instance",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
  // --- assessment ---
  rc({
    objectType: "assessment",
    relation: "parent",
    directlyAssignable: [{ type: "organization" }],
  }),
  rc({
    objectType: "assessment",
    relation: "owner",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "assessment",
    relation: "delegate",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "assessment",
    relation: "editor",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "admin" },
      { tupleset: "parent", computedUserset: "owner" },
    ],
  }),
  rc({
    objectType: "assessment",
    relation: "viewer",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
    impliedBy: ["editor"],
  }),
  rc({
    objectType: "assessment",
    relation: "blocked",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "assessment",
    relation: "_editor_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "assessment",
    relation: "_viewer_not_blocked",
    directlyAssignable: [],
    impliedBy: ["viewer"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "assessment",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }],
    impliedBy: ["owner", "_editor_not_blocked"],
  }),
  rc({
    objectType: "assessment",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }],
    impliedBy: ["owner", "delegate", "_editor_not_blocked"],
  }),
  rc({
    objectType: "assessment",
    relation: "can_view",
    directlyAssignable: [{ type: "user" }],
    impliedBy: ["can_edit", "_viewer_not_blocked"],
  }),
  // --- campaign ---
  rc({
    objectType: "campaign",
    relation: "parent",
    directlyAssignable: [
      { type: "user" },
      { type: "service" },
      { type: "organization" },
    ],
  }),
  rc({
    objectType: "campaign",
    relation: "editor",
    directlyAssignable: [
      { type: "group", relation: "member" },
      { type: "organization", relation: "owner" },
    ],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
  }),
  rc({
    objectType: "campaign",
    relation: "viewer",
    directlyAssignable: [{ type: "group", relation: "member" }],
    impliedBy: ["editor"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  rc({
    objectType: "campaign",
    relation: "blocked",
    directlyAssignable: [
      { type: "user" },
      { type: "group", relation: "member" },
    ],
  }),
  rc({
    objectType: "campaign",
    relation: "_editor_not_blocked",
    directlyAssignable: [],
    impliedBy: ["editor"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "campaign",
    relation: "_viewer_not_blocked",
    directlyAssignable: [],
    impliedBy: ["viewer"],
    excludedBy: "blocked",
  }),
  rc({
    objectType: "campaign",
    relation: "can_delete",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["_editor_not_blocked"],
  }),
  rc({
    objectType: "campaign",
    relation: "can_edit",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["_editor_not_blocked"],
  }),
  rc({
    objectType: "campaign",
    relation: "can_view",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    impliedBy: ["can_edit", "_viewer_not_blocked"],
  }),
  rc({
    objectType: "campaign",
    relation: "audit_log_viewer",
    directlyAssignable: [{ type: "user" }, { type: "service" }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "audit_log_viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "can_view" },
    ],
  }),
];

// === Tuples ===

type Tuple = Omit<AddTupleRequest, "objectId" | "subjectId"> & {
  objectId: string;
  subjectId: string;
};

const TUPLES: Tuple[] = [
  // Self-referencing tuples for user/service types
  {
    objectType: "user",
    objectId: uuid("alice"),
    relation: "_self",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "service",
    objectId: uuid("svc_api"),
    relation: "_self",
    subjectType: "service",
    subjectId: uuid("svc_api"),
  },
  // Organization: acme
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "owner",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "admin",
    subjectType: "user",
    subjectId: uuid("bob"),
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "member",
    subjectType: "user",
    subjectId: uuid("charlie"),
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "member",
    subjectType: "user",
    subjectId: uuid("grace"),
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "access",
    subjectType: "organization",
    subjectId: uuid("acme"),
    subjectRelation: "member",
    conditionName: "email_domains_allowed",
    conditionContext: { allowed_domains: ["acme.com"] },
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "can_edit",
    subjectType: "service",
    subjectId: uuid("svc_api"),
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "can_delete",
    subjectType: "service",
    subjectId: uuid("svc_api"),
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "audit_log_viewer",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "trust_center_admin",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "standard_creator",
    subjectType: "group",
    subjectId: uuid("editors_grp"),
    subjectRelation: "member",
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "group_creator",
    subjectType: "group",
    subjectId: uuid("editors_grp"),
    subjectRelation: "member",
  },
  {
    objectType: "organization",
    objectId: uuid("acme"),
    relation: "can_view",
    subjectType: "user",
    subjectId: uuid("alice"),
    conditionName: "time_based_grant",
    conditionContext: {
      grant_time: "2025-01-01T00:00:00Z",
      grant_duration: "3600s",
    },
  },
  // Organization: subsidiary
  {
    objectType: "organization",
    objectId: uuid("subsidiary"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  // System: sys_main
  {
    objectType: "system",
    objectId: uuid("sys_main"),
    relation: "system_admin",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "system",
    objectId: uuid("sys_main"),
    relation: "system_admin",
    subjectType: "service",
    subjectId: uuid("svc_api"),
  },
  // Feature: feat_sso
  {
    objectType: "feature",
    objectId: uuid("feat_sso"),
    relation: "enabled",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  // Groups
  {
    objectType: "group",
    objectId: uuid("engineering"),
    relation: "member",
    subjectType: "user",
    subjectId: uuid("eve"),
  },
  {
    objectType: "group",
    objectId: uuid("engineering"),
    relation: "member",
    subjectType: "user",
    subjectId: uuid("frank"),
  },
  {
    objectType: "group",
    objectId: uuid("engineering"),
    relation: "admin",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "group",
    objectId: uuid("engineering"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
    conditionName: "public_group",
    conditionContext: { public: true },
  },
  {
    objectType: "group",
    objectId: uuid("engineering"),
    relation: "parent_admin",
    subjectType: "organization",
    subjectId: uuid("acme"),
    subjectRelation: "owner",
  },
  {
    objectType: "group",
    objectId: uuid("editors_grp"),
    relation: "member",
    subjectType: "user",
    subjectId: uuid("charlie"),
  },
  {
    objectType: "group",
    objectId: uuid("auditors_grp"),
    relation: "member",
    subjectType: "user",
    subjectId: uuid("henry"),
  },
  // Program: prog_compliance
  {
    objectType: "program",
    objectId: uuid("prog_compliance"),
    relation: "admin",
    subjectType: "user",
    subjectId: uuid("grace"),
  },
  {
    objectType: "program",
    objectId: uuid("prog_compliance"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  {
    objectType: "program",
    objectId: uuid("prog_compliance"),
    relation: "editor",
    subjectType: "group",
    subjectId: uuid("engineering"),
    subjectRelation: "member",
  },
  {
    objectType: "program",
    objectId: uuid("prog_compliance"),
    relation: "blocked",
    subjectType: "user",
    subjectId: uuid("frank"),
  },
  {
    objectType: "program",
    objectId: uuid("prog_compliance"),
    relation: "can_edit",
    subjectType: "service",
    subjectId: uuid("svc_api"),
  },
  // Control: ctrl_soc2
  {
    objectType: "control",
    objectId: uuid("ctrl_soc2"),
    relation: "parent",
    subjectType: "program",
    subjectId: uuid("prog_compliance"),
  },
  {
    objectType: "control",
    objectId: uuid("ctrl_soc2"),
    relation: "owner",
    subjectType: "group",
    subjectId: uuid("engineering"),
    subjectRelation: "member",
  },
  {
    objectType: "control",
    objectId: uuid("ctrl_soc2"),
    relation: "delegate",
    subjectType: "group",
    subjectId: uuid("auditors_grp"),
    subjectRelation: "member",
  },
  {
    objectType: "control",
    objectId: uuid("ctrl_soc2"),
    relation: "system",
    subjectType: "system",
    subjectId: uuid("sys_main"),
  },
  // Subcontrol: sub_access
  {
    objectType: "subcontrol",
    objectId: uuid("sub_access"),
    relation: "parent",
    subjectType: "control",
    subjectId: uuid("ctrl_soc2"),
  },
  // Internal policy: policy_data
  {
    objectType: "internal_policy",
    objectId: uuid("policy_data"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  {
    objectType: "internal_policy",
    objectId: uuid("policy_data"),
    relation: "admin",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "internal_policy",
    objectId: uuid("policy_data"),
    relation: "editor",
    subjectType: "group",
    subjectId: uuid("engineering"),
    subjectRelation: "member",
  },
  {
    objectType: "internal_policy",
    objectId: uuid("policy_data"),
    relation: "approver",
    subjectType: "group",
    subjectId: uuid("auditors_grp"),
    subjectRelation: "member",
  },
  {
    objectType: "internal_policy",
    objectId: uuid("policy_data"),
    relation: "blocked",
    subjectType: "user",
    subjectId: uuid("frank"),
  },
  // Contact: contact_vendor
  {
    objectType: "contact",
    objectId: uuid("contact_vendor"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  {
    objectType: "contact",
    objectId: uuid("contact_vendor"),
    relation: "_direct_and_parent_member_view",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "contact",
    objectId: uuid("contact_vendor"),
    relation: "_direct_and_parent_member_view",
    subjectType: "user",
    subjectId: uuid("bob"),
  },
  {
    objectType: "contact",
    objectId: uuid("contact_vendor"),
    relation: "editor",
    subjectType: "group",
    subjectId: uuid("engineering"),
    subjectRelation: "member",
  },
  {
    objectType: "contact",
    objectId: uuid("contact_vendor"),
    relation: "blocked",
    subjectType: "user",
    subjectId: uuid("frank"),
  },
  // Task: task_review
  {
    objectType: "task",
    objectId: uuid("task_review"),
    relation: "parent",
    subjectType: "control",
    subjectId: uuid("ctrl_soc2"),
  },
  {
    objectType: "task",
    objectId: uuid("task_review"),
    relation: "assignee",
    subjectType: "user",
    subjectId: uuid("eve"),
  },
  {
    objectType: "task",
    objectId: uuid("task_review"),
    relation: "assigner",
    subjectType: "user",
    subjectId: uuid("grace"),
  },
  // Note: note_ctrl
  {
    objectType: "note",
    objectId: uuid("note_ctrl"),
    relation: "parent",
    subjectType: "control",
    subjectId: uuid("ctrl_soc2"),
  },
  {
    objectType: "note",
    objectId: uuid("note_ctrl"),
    relation: "owner",
    subjectType: "user",
    subjectId: uuid("grace"),
  },
  // Evidence: evidence_doc
  {
    objectType: "evidence",
    objectId: uuid("evidence_doc"),
    relation: "parent",
    subjectType: "program",
    subjectId: uuid("prog_compliance"),
  },
  {
    objectType: "evidence",
    objectId: uuid("evidence_doc"),
    relation: "editor",
    subjectType: "group",
    subjectId: uuid("engineering"),
    subjectRelation: "member",
  },
  {
    objectType: "evidence",
    objectId: uuid("evidence_doc"),
    relation: "blocked",
    subjectType: "user",
    subjectId: uuid("frank"),
  },
  // Standard: std_iso
  {
    objectType: "standard",
    objectId: uuid("std_iso"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  {
    objectType: "standard",
    objectId: uuid("std_iso"),
    relation: "editor",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "standard",
    objectId: uuid("std_iso"),
    relation: "can_view",
    subjectType: "user",
    subjectId: WILDCARD,
  },
  // Trust center: tc_acme
  {
    objectType: "trust_center",
    objectId: uuid("tc_acme"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  {
    objectType: "trust_center",
    objectId: uuid("tc_acme"),
    relation: "nda_signed",
    subjectType: "user",
    subjectId: uuid("diana"),
  },
  {
    objectType: "trust_center",
    objectId: uuid("tc_acme"),
    relation: "editor",
    subjectType: "group",
    subjectId: uuid("engineering"),
    subjectRelation: "member",
  },
  {
    objectType: "trust_center",
    objectId: uuid("tc_acme"),
    relation: "system",
    subjectType: "system",
    subjectId: uuid("sys_main"),
  },
  // Trust center docs
  {
    objectType: "trust_center_doc",
    objectId: uuid("tc_doc_public"),
    relation: "parent",
    subjectType: "trust_center",
    subjectId: uuid("tc_acme"),
  },
  {
    objectType: "trust_center_doc",
    objectId: uuid("tc_doc_private"),
    relation: "parent",
    subjectType: "trust_center",
    subjectId: uuid("tc_acme"),
  },
  {
    objectType: "trust_center_doc",
    objectId: uuid("tc_doc_public"),
    relation: "can_view",
    subjectType: "user",
    subjectId: WILDCARD,
  },
  {
    objectType: "trust_center_doc",
    objectId: uuid("tc_doc_public"),
    relation: "can_view",
    subjectType: "service",
    subjectId: WILDCARD,
  },
  // File: file_logo
  {
    objectType: "file",
    objectId: uuid("file_logo"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  {
    objectType: "file",
    objectId: uuid("file_logo"),
    relation: "can_view",
    subjectType: "user",
    subjectId: WILDCARD,
  },
  // File: file_ctrl
  {
    objectType: "file",
    objectId: uuid("file_ctrl"),
    relation: "parent",
    subjectType: "control",
    subjectId: uuid("ctrl_soc2"),
  },
  {
    objectType: "file",
    objectId: uuid("file_ctrl"),
    relation: "tc_doc_parent",
    subjectType: "trust_center_doc",
    subjectId: uuid("tc_doc_private"),
  },
  // Export: export_data
  {
    objectType: "export",
    objectId: uuid("export_data"),
    relation: "system",
    subjectType: "system",
    subjectId: uuid("sys_main"),
  },
  {
    objectType: "export",
    objectId: uuid("export_data"),
    relation: "can_edit",
    subjectType: "service",
    subjectId: uuid("svc_api"),
  },
  // Workflow definition: wf_def
  {
    objectType: "workflow_definition",
    objectId: uuid("wf_def"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  {
    objectType: "workflow_definition",
    objectId: uuid("wf_def"),
    relation: "admin",
    subjectType: "user",
    subjectId: uuid("bob"),
  },
  // Workflow instance: wf_instance
  {
    objectType: "workflow_instance",
    objectId: uuid("wf_instance"),
    relation: "parent",
    subjectType: "workflow_definition",
    subjectId: uuid("wf_def"),
  },
  {
    objectType: "workflow_instance",
    objectId: uuid("wf_instance"),
    relation: "can_view",
    subjectType: "service",
    subjectId: uuid("svc_api"),
  },
  // Assessment: assess_q1
  {
    objectType: "assessment",
    objectId: uuid("assess_q1"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  {
    objectType: "assessment",
    objectId: uuid("assess_q1"),
    relation: "owner",
    subjectType: "user",
    subjectId: uuid("grace"),
  },
  {
    objectType: "assessment",
    objectId: uuid("assess_q1"),
    relation: "delegate",
    subjectType: "user",
    subjectId: uuid("eve"),
  },
  {
    objectType: "assessment",
    objectId: uuid("assess_q1"),
    relation: "blocked",
    subjectType: "user",
    subjectId: uuid("frank"),
  },
  // Campaign: camp_onboard
  {
    objectType: "campaign",
    objectId: uuid("camp_onboard"),
    relation: "parent",
    subjectType: "organization",
    subjectId: uuid("acme"),
  },
  {
    objectType: "campaign",
    objectId: uuid("camp_onboard"),
    relation: "editor",
    subjectType: "group",
    subjectId: uuid("engineering"),
    subjectRelation: "member",
  },
  {
    objectType: "campaign",
    objectId: uuid("camp_onboard"),
    relation: "blocked",
    subjectType: "user",
    subjectId: uuid("frank"),
  },
];

// === Setup & Teardown ===

export interface TheopenlaneSetup {
  db: Kysely<DB>;
  storeId: string;
  authorizationModelId: string;
  tsfgaClient: TsfgaClient;
  /** What this setup wrote, for the config drift assertion. */
  fixture: FixtureRecord;
}

export async function setupTheopenlane(): Promise<TheopenlaneSetup> {
  const db = getDb();
  await beginTransaction(db);

  const store = new KyselyTupleStore(db);
  const tsfgaClient = createTsfga(store);
  const fixture = recordFixture(tsfgaClient);

  for (const condDef of CONDITION_DEFS) {
    await tsfgaClient.writeConditionDefinition(condDef);
  }

  for (const config of RELATION_CONFIGS) {
    await tsfgaClient.writeRelationConfig(config);
  }

  for (const tuple of TUPLES) {
    await tsfgaClient.addTuple(tuple);
  }

  const storeId = await fgaCreateStore("theopenlane-conformance");
  const authorizationModelId = await fgaWriteModel(
    storeId,
    "./theopenlane/model.dsl",
  );
  await fgaWriteTuples(
    storeId,
    "./theopenlane/tuples.yaml",
    authorizationModelId,
    uuidMap,
  );

  return { db, storeId, authorizationModelId, tsfgaClient, fixture };
}

export async function teardownTheopenlane(db: Kysely<DB>): Promise<void> {
  await rollbackTransaction(db);
  await destroyDb();
}
