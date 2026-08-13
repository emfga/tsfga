import { createTsfga, type TsfgaClient } from "@tsfga/core";
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
  type FgaTupleYaml,
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuplesRaw,
} from "../helpers/openfga.ts";
import { MATRIX_CONFIGS } from "./configs.ts";

/**
 * The plumbing behind the `complexity3` / `complexity4` port.
 *
 * Deliberately a sibling of `listobjects-matrix/harness.ts` rather than an
 * edit of it: the fixtures are separately owned, and this one
 * carries two more types and a different set of decompositions.
 * The isolation rule is the same and load-bearing for the same
 * reason — upstream gives every matrix case its own store, and
 * several cases write `user:*` on a relation a later case asks
 * about for an unrelated subject.
 */

const IDS = new Map<string, string>();

/**
 * A UUID for an upstream object or subject name, minted on first
 * use. Every id is under this fixture's own `d4d0` prefix, so it
 * cannot collide with another fixture's rows.
 */
export function uuid(name: string): string {
  const existing = IDS.get(name);
  if (existing !== undefined) return existing;
  const id = `00000000-0000-4000-d4d0-${(IDS.size + 1)
    .toString(16)
    .padStart(12, "0")}`;
  IDS.set(name, id);
  return id;
}

/**
 * Where a tuple lands on the tsfga side when the DSL relation it
 * names was decomposed.
 *
 * `usersets_user_c1.userset_intersect_mixed` is
 * `[...] and (...)`; tsfga's is the intersection alone and the
 * direct assignment lives on `h_uim_direct`. OpenFGA is still
 * written the tuple the matrix states, so the two engines are
 * asked about the same grant.
 */
const TSFGA_MOVES = new Map<string, string>([
  ["usersets_user_c1.userset_intersect_mixed", "h_uim_direct"],
]);

function tsfgaRelation(objectType: string, relation: string): string {
  return TSFGA_MOVES.get(`${objectType}.${relation}`) ?? relation;
}

/** A tuple as the Go matrix spells it: `type:name` refs. */
export interface MatrixTuple {
  object: string;
  relation: string;
  user: string;
  /** The condition name, `xcond_c1` in every upstream case. */
  condition?: string;
}

export interface MatrixAssertion {
  /** `type:name` or `type:name#relation`. */
  user: string;
  type: string;
  relation: string;
  context?: Record<string, unknown>;
  expect: string[];
  /** Issue number, when this assertion is one that fails today. */
  issue?: string;
}

/** A single `check`, as `tests/check/*.go` spells one. */
export interface CheckAssertion {
  name: string;
  /** `type:name` or `type:name#relation`. */
  object: string;
  relation: string;
  /** `type:name` or `type:name#relation`. */
  user: string;
  context?: Record<string, unknown>;
  expect: boolean;
  issue?: string;
}

export interface MatrixCase {
  name: string;
  tuples: MatrixTuple[];
  assertions?: MatrixAssertion[];
  checks?: CheckAssertion[];
}

interface Ref {
  type: string;
  id: string;
  relation: string | null;
}

function parseRef(ref: string): Ref {
  const hash = ref.indexOf("#");
  const base = hash >= 0 ? ref.slice(0, hash) : ref;
  const relation = hash >= 0 ? ref.slice(hash + 1) : null;
  const colon = base.indexOf(":");
  if (colon < 0) throw new Error(`Not a ref: ${ref}`);
  const name = base.slice(colon + 1);
  return {
    type: base.slice(0, colon),
    id: name === "*" ? "*" : uuid(name),
    relation,
  };
}

/** `type:uuid` / `type:uuid#relation`, as OpenFGA's wire spells it. */
function renderRef(ref: Ref): string {
  return ref.relation
    ? `${ref.type}:${ref.id}#${ref.relation}`
    : `${ref.type}:${ref.id}`;
}

export interface MatrixEnv {
  db: Kysely<DB>;
  tsfgaClient: TsfgaClient;
  fixture: FixtureRecord;
}

export async function setupMatrix(): Promise<MatrixEnv> {
  const db = getDb();
  await beginTransaction(db);
  const tsfgaClient = createTsfga(new KyselyTupleStore(db));
  const fixture = recordFixture(tsfgaClient);
  await tsfgaClient.writeConditionDefinition({
    name: "xcond_c1",
    expression: "x == '1'",
    parameters: { x: "string" },
  });
  for (const config of MATRIX_CONFIGS) {
    await tsfgaClient.writeRelationConfig(config);
  }
  return { db, tsfgaClient, fixture };
}

export async function teardownMatrix(db: Kysely<DB>): Promise<void> {
  await rollbackTransaction(db);
  await destroyDb();
}

/**
 * A store carrying the matrix model and nothing else, for one case.
 */
export async function createCaseStore(
  name: string,
): Promise<{ storeId: string; authorizationModelId: string }> {
  const storeId = await fgaCreateStore(`complexity-matrix-${name}`);
  const authorizationModelId = await fgaWriteModel(
    storeId,
    "./complexity-matrix/model.dsl",
  );
  return { storeId, authorizationModelId };
}

/**
 * The case's tuples, deduplicated on the natural key.
 *
 * tsfga upserts a repeated key and OpenFGA rejects the whole write
 * request for one, so the two disagree about a duplicate before any
 * assertion runs.
 */
function dedupe(tuples: MatrixTuple[]): MatrixTuple[] {
  const seen = new Set<string>();
  const kept: MatrixTuple[] = [];
  for (const tuple of tuples) {
    const key = `${tuple.object}|${tuple.relation}|${tuple.user}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(tuple);
  }
  return kept;
}

export async function writeCaseTuples(
  client: TsfgaClient,
  storeId: string,
  authorizationModelId: string,
  tuples: MatrixTuple[],
): Promise<void> {
  const rows = dedupe(tuples);
  for (const tuple of rows) {
    const object = parseRef(tuple.object);
    const subject = parseRef(tuple.user);
    await client.addTuple({
      objectType: object.type,
      objectId: object.id,
      relation: tsfgaRelation(object.type, tuple.relation),
      subjectType: subject.type,
      subjectId: subject.id,
      subjectRelation: subject.relation,
      conditionName: tuple.condition ?? null,
    });
  }
  const yaml: FgaTupleYaml[] = rows.map((tuple) => ({
    object: renderRef(parseRef(tuple.object)),
    relation: tuple.relation,
    user: renderRef(parseRef(tuple.user)),
    ...(tuple.condition ? { condition: { name: tuple.condition } } : {}),
  }));
  await fgaWriteTuplesRaw(storeId, authorizationModelId, yaml);
}

export async function removeCaseTuples(
  client: TsfgaClient,
  tuples: MatrixTuple[],
): Promise<void> {
  for (const tuple of dedupe(tuples)) {
    const object = parseRef(tuple.object);
    const subject = parseRef(tuple.user);
    await client.removeTuple({
      objectType: object.type,
      objectId: object.id,
      relation: tsfgaRelation(object.type, tuple.relation),
      subjectType: subject.type,
      subjectId: subject.id,
      subjectRelation: subject.relation,
    });
  }
}

/** The `listObjects` request an assertion describes. */
export function assertionRequest(assertion: MatrixAssertion): {
  objectType: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation: string | null;
  context?: Record<string, unknown>;
} {
  const subject = parseRef(assertion.user);
  return {
    objectType: assertion.type,
    relation: assertion.relation,
    subjectType: subject.type,
    subjectId: subject.id,
    subjectRelation: subject.relation,
    ...(assertion.context ? { context: assertion.context } : {}),
  };
}

/** The object ids an assertion expects, as tsfga reports them. */
export function assertionExpectation(assertion: MatrixAssertion): string[] {
  return assertion.expect.map((ref) => parseRef(ref).id);
}

/** The `check` request an assertion describes. */
export function checkRequest(assertion: CheckAssertion): {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation: string | null;
  context?: Record<string, unknown>;
} {
  const object = parseRef(assertion.object);
  const subject = parseRef(assertion.user);
  return {
    objectType: object.type,
    objectId: object.id,
    relation: assertion.relation,
    subjectType: subject.type,
    subjectId: subject.id,
    subjectRelation: subject.relation,
    ...(assertion.context ? { context: assertion.context } : {}),
  };
}

/** The condition context upstream's `xcond` accepts and rejects. */
export const VALID_CONTEXT = { x: "1" };
export const INVALID_CONTEXT = { x: "9" };
