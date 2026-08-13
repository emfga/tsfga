import * as fs from "node:fs";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import { ErrorCode, FgaApiValidationError, OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import { parse as parseYaml } from "yaml";

const apiUrl = process.env.FGA_API_URL;

/**
 * The refusal codes that mean "the model rejected this request",
 * as opposed to "the request never reached the model".
 *
 * The class alone cannot make that distinction: a genuine refusal,
 * a bogus store id and a bogus authorization model id are *all*
 * `FgaApiValidationError`. Only the code separates them, and it is
 * a documented enum rather than message text, so matching on it
 * does not go stale when a message is reworded. Anything not
 * listed here re-raises with the original attached, because a
 * helper that reports "refused" for a a broken fixture turns every
 * refusal assertion into a tautology.
 */
const MODEL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  ErrorCode.ValidationError,
  ErrorCode.InvalidTuple,
  ErrorCode.InvalidUser,
  ErrorCode.TypeNotFound,
  ErrorCode.RelationNotFound,
  ErrorCode.UnknownRelation,
  ErrorCode.InvalidWriteInput,
  ErrorCode.WriteFailedDueToInvalidInput,
  // The engine declining to resolve is a refusal about the
  // request, not a transport failure: it is what OpenFGA answers
  // instead of a boolean when the model is too deeply nested.
  ErrorCode.AuthorizationModelResolutionTooComplex,
]);

/** How OpenFGA refused, when it refused for a reason the model owns. */
export interface FgaRefusal {
  outcome: "refused";
  code: string;
  reason: string;
}

function refusalOf(error: unknown): FgaRefusal | null {
  if (!(error instanceof FgaApiValidationError)) return null;
  const code = error.apiErrorCode;
  if (typeof code !== "string" || !MODEL_REFUSAL_CODES.has(code)) return null;
  return {
    outcome: "refused",
    code,
    reason: error.apiErrorMessage ?? error.message,
  };
}

function createClient(storeId?: string): OpenFgaClient {
  return new OpenFgaClient({
    apiUrl,
    storeId,
  });
}

/**
 * `CreateStoreRequest.Name` is bounded at 64 characters, and a
 * store name here is diagnostic rather than load-bearing — it is
 * what identifies the store in the playground and nothing reads it
 * back. A fixture that composes its name from a file slug and a
 * case name can cross the bound just by being renamed, and the
 * failure that produces is a 400 on store creation followed by a
 * cascade of unrelated-looking errors from the case's own writes.
 *
 * So the bound is enforced here, once, and the **tail** is what
 * survives: the case name discriminates, the prefix repeats.
 */
const STORE_NAME_MAX = 64;

export async function fgaCreateStore(name: string): Promise<string> {
  const client = createClient();
  const response = await client.createStore({
    name: name.length > STORE_NAME_MAX ? name.slice(-STORE_NAME_MAX) : name,
  });
  return response.id;
}

export async function fgaWriteModel(
  storeId: string,
  modelPath: string,
): Promise<string> {
  const client = createClient(storeId);
  const dsl = fs.readFileSync(modelPath, "utf-8");
  const modelJson = transformer.transformDSLToJSONObject(dsl);
  const response = await client.writeAuthorizationModel(modelJson);
  return response.authorization_model_id;
}

/**
 * The refusal codes a *model* write reports.
 *
 * Kept apart from `MODEL_REFUSAL_CODES` because they are refusals
 * of a different request: `invalid_authorization_model` cannot
 * come back from a check or a tuple write, and treating it as a
 * refusal there would report a mis-addressed request as a
 * behavioural agreement.
 *
 * The four below are the same refusal reached earlier. A malformed
 * type or relation *name* fails the API's protobuf pattern before
 * the typesystem runs, so it never reaches
 * `invalid_authorization_model` — it is still the model refusing
 * the model, and a helper that re-raised it would report an
 * assertable refusal as a transport failure.
 *
 * Measured against the v1.18.2 container rather than taken from
 * the finder's list, which named `relation_invalid_pattern` and
 * `relation_invalid_length`: neither exists in the SDK's
 * `ErrorCode` enum, and neither is what comes back. A relation
 * name is reported as **`relations_invalid_pattern`** (plural),
 * against `^[^:#@\s]{1,50}$`, and a type name as
 * `type_invalid_pattern`. The pattern carries the length bound, so
 * an over-long name of either kind is refused as a pattern
 * mismatch and the two `*_length` codes were not observed; they
 * are listed because they are the same family and the enum
 * defines them.
 */
const MODEL_WRITE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  ErrorCode.InvalidAuthorizationModel,
  ErrorCode.ValidationError,
  ErrorCode.TypeInvalidPattern,
  ErrorCode.TypeInvalidLength,
  ErrorCode.RelationsInvalidPattern,
  ErrorCode.RelationsTooLong,
]);

/**
 * Write a model given as JSON and report whether OpenFGA took it.
 *
 * Takes the JSON rather than a DSL path because the shapes worth
 * asserting here are ones the DSL cannot express: a condition
 * whose expression does not compile is rejected by the
 * transformer before it can ever reach the server.
 */
export async function fgaWriteModelOutcome(
  storeId: string,
  model: WriteAuthorizationModelRequest,
): Promise<"accepted" | FgaRefusal> {
  const client = createClient(storeId);
  try {
    await client.writeAuthorizationModel(model);
    return "accepted";
  } catch (error) {
    if (
      error instanceof FgaApiValidationError &&
      typeof error.apiErrorCode === "string" &&
      MODEL_WRITE_REFUSAL_CODES.has(error.apiErrorCode)
    ) {
      return {
        outcome: "refused",
        code: error.apiErrorCode,
        reason: error.apiErrorMessage ?? error.message,
      };
    }
    throw error;
  }
}

export interface FgaTupleYaml {
  user: string;
  relation: string;
  object: string;
  condition?: {
    name: string;
    context?: Record<string, unknown>;
  };
}

export async function fgaWriteTuples(
  storeId: string,
  tuplesPath: string,
  authorizationModelId: string,
  uuidMap?: Map<string, string>,
): Promise<void> {
  const client = createClient(storeId);
  const raw = fs.readFileSync(tuplesPath, "utf-8");
  const tuples = parseYaml(raw) as FgaTupleYaml[];

  const mapped = tuples.map((t) => ({
    user: resolveRef(t.user, uuidMap),
    relation: t.relation,
    object: resolveRef(t.object, uuidMap),
    condition: t.condition,
  }));

  await client.writeTuples(mapped, { authorizationModelId });
}

function resolveRef(ref: string, uuidMap?: Map<string, string>): string {
  if (!uuidMap) return ref;

  // Handle type:name#relation format
  const hashIdx = ref.indexOf("#");
  const base = hashIdx >= 0 ? ref.slice(0, hashIdx) : ref;
  const suffix = hashIdx >= 0 ? ref.slice(hashIdx) : "";

  const colonIdx = base.indexOf(":");
  if (colonIdx < 0) return ref;

  const type = base.slice(0, colonIdx);
  const name = base.slice(colonIdx + 1);

  // The typed wildcard is a subject shape, not an id, so it is
  // never a map key. It is the only ref that legitimately passes
  // through — 40 rows across 17 files spell it, and throwing on
  // it reds every one of them.
  if (name === "*") return ref;

  const uuid = uuidMap.get(name);
  if (uuid === undefined) {
    // Passing an unmapped ref through leaves the OpenFGA store
    // half-migrated: it holds a grant on a slug while tsfga holds
    // one on a UUID, so each engine answers `false` about the
    // object the other one has, the two agree, and every
    // assertion over that object goes quietly vacuous.
    throw new Error(`resolveRef: no UUID mapped for "${name}" in "${ref}"`);
  }

  return `${type}:${uuid}${suffix}`;
}

export interface FgaContextualTuple {
  user: string;
  relation: string;
  object: string;
  /**
   * Carried for the same reason `writeOneTuple` carries it: a
   * contextual tuple is admitted by the type restriction that
   * names its condition, and then evaluated. Dropping it asks
   * OpenFGA about a *different* tuple.
   *
   * Both directions are wrong, and the second is the dangerous
   * one. On `[user with cond]` the stripped tuple is not admitted
   * at all, so upstream refuses a request it would have answered
   * and the suite reports a divergence the engines do not have.
   * But on a relation admitting `[user, user with cond]` the
   * stripped tuple *is* admitted, unconditionally -- upstream
   * answers `true` without ever evaluating the condition and
   * agrees with tsfga for the wrong reason, passing an assertion
   * that tested nothing.
   */
  condition?: { name: string; context?: Record<string, unknown> };
}

/**
 * The subject as OpenFGA's `user` field spells it.
 *
 * A subject relation makes it a userset — `group:eng#member` —
 * which is one of the two forms `TupleKey.user` takes. Dropping it
 * would ask OpenFGA about the bare `group:eng`, a *different*
 * subject that the same model answers differently, so the
 * assertion would compare two questions rather than two engines.
 */
function fgaUser(subject: {
  subjectType: string;
  subjectId: string;
  subjectRelation?: string | null;
}): string {
  return subject.subjectRelation
    ? `${subject.subjectType}:${subject.subjectId}#${subject.subjectRelation}`
    : `${subject.subjectType}:${subject.subjectId}`;
}

export interface FgaCheckParams {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string | null;
  context?: Record<string, unknown>;
  contextualTuples?: FgaContextualTuple[];
}

export async function fgaCheck(
  storeId: string,
  authorizationModelId: string,
  params: FgaCheckParams,
): Promise<boolean | FgaRefusal | null> {
  const client = createClient(storeId);
  try {
    const response = await client.check(
      {
        user: fgaUser(params),
        relation: params.relation,
        object: `${params.objectType}:${params.objectId}`,
        context: params.context,
        contextualTuples: params.contextualTuples,
      },
      { authorizationModelId },
    );
    return response.allowed ?? null;
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal) return refusal;
    throw error;
  }
}

export interface FgaListObjectsParams {
  objectType: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string | null;
  context?: Record<string, unknown>;
  contextualTuples?: FgaContextualTuple[];
}

/**
 * The object ids of one type the subject reaches, as OpenFGA's
 * ListObjects reports them.
 *
 * Ids, not `type:id`, because that is what tsfga's `listObjects`
 * returns and a comparison has to be of the same thing. The prefix
 * is asserted rather than trimmed blindly: an object of another
 * type coming back would otherwise be silently renamed into one of
 * the type asked for.
 *
 * Unsorted, because sorting belongs to the comparison rather than
 * to the binding — the two engines do not agree on order and need
 * not, and hiding that here would hide it from every caller.
 */
export async function fgaListObjects(
  storeId: string,
  authorizationModelId: string,
  params: FgaListObjectsParams,
): Promise<string[]> {
  const client = createClient(storeId);
  const response = await client.listObjects(
    {
      user: fgaUser(params),
      relation: params.relation,
      type: params.objectType,
      context: params.context,
      contextualTuples: params.contextualTuples,
    },
    { authorizationModelId },
  );
  const prefix = `${params.objectType}:`;
  return (response.objects ?? []).map((object) => {
    if (!object.startsWith(prefix)) {
      throw new Error(
        `ListObjects returned ${object} for type ${params.objectType}`,
      );
    }
    return object.slice(prefix.length);
  });
}

/**
 * Write one tuple and report whether OpenFGA accepted it.
 *
 * Distinct from `fgaWriteTuples`, which reads a fixture and lets a
 * rejection throw. Here the rejection *is* the result under test,
 * so it is reported rather than raised.
 */
export interface FgaWriteTuple {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string | null;
  conditionName?: string | null;
  conditionContext?: Record<string, unknown> | null;
}

export async function fgaWrite(
  storeId: string,
  authorizationModelId: string,
  tuple: FgaWriteTuple,
): Promise<"accepted" | "refused"> {
  const outcome = await fgaWriteOutcome(storeId, authorizationModelId, tuple);
  return outcome === "accepted" ? "accepted" : "refused";
}

async function writeOneTuple(
  storeId: string,
  authorizationModelId: string,
  tuple: FgaWriteTuple,
): Promise<void> {
  const client = createClient(storeId);
  const user = tuple.subjectRelation
    ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
    : `${tuple.subjectType}:${tuple.subjectId}`;
  await client.writeTuples(
    [
      {
        user,
        relation: tuple.relation,
        object: `${tuple.objectType}:${tuple.objectId}`,
        // The condition is part of what the write is validated
        // against, so a write-conformance assertion that dropped
        // it would compare two different writes.
        ...(tuple.conditionName
          ? {
              condition: {
                name: tuple.conditionName,
                ...(tuple.conditionContext
                  ? { context: tuple.conditionContext }
                  : {}),
              },
            }
          : {}),
      },
    ],
    { authorizationModelId },
  );
}

/**
 * As `fgaWrite`, but reporting *how* OpenFGA refused.
 *
 * Exists so a suite can assert that upstream discriminates a set
 * of refusals as finely as tsfga does, without asserting that the
 * two produce the same prose -- they do not, and pinning that
 * would be pinning OpenFGA's wording rather than its behaviour.
 */
export async function fgaWriteOutcome(
  storeId: string,
  authorizationModelId: string,
  tuple: FgaWriteTuple,
): Promise<"accepted" | FgaRefusal> {
  try {
    await writeOneTuple(storeId, authorizationModelId, tuple);
    return "accepted";
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal) return refusal;
    throw error;
  }
}

/**
 * Write tuples verbatim, conditions included.
 *
 * `fgaWriteTuples` reads a YAML fixture; this takes the tuples
 * directly, for a fixture whose rows are the thing under test and
 * are written under one model and then read under another.
 */
export async function fgaWriteTuplesRaw(
  storeId: string,
  authorizationModelId: string,
  tuples: FgaTupleYaml[],
): Promise<void> {
  const client = createClient(storeId);
  await client.writeTuples(tuples, { authorizationModelId });
}

/**
 * Delete one tuple, and report whether OpenFGA took the request
 * at all.
 *
 * Two outcomes rather than three, and the distinction is the
 * point: `"refused"` is a `validation_error` on the request's own
 * shape, and `"missing"` is
 * `write_failed_due_to_invalid_input` — the request was
 * well-formed and the row was not there. Upstream reaches them
 * from different places (protovalidate and `IsValidUser` at the
 * boundary, the missing-row check inside `Execute` afterwards),
 * and a delete that is both malformed *and* nonexistent must
 * report the first.
 */
export async function fgaDeleteOutcome(
  storeId: string,
  authorizationModelId: string,
  tuple: FgaWriteTuple,
): Promise<"accepted" | "refused" | "missing"> {
  const client = createClient(storeId);
  // `!== null` rather than truthiness, unlike `writeOneTuple`
  // above: an **empty** subject relation is one of the shapes
  // under test, and it is a different wire string from an absent
  // one. `user:alice#` fails `IsValidUser`; `user:alice` does not.
  const user =
    tuple.subjectRelation === null || tuple.subjectRelation === undefined
      ? `${tuple.subjectType}:${tuple.subjectId}`
      : `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`;
  try {
    await client.deleteTuples(
      [
        {
          user,
          relation: tuple.relation,
          object: `${tuple.objectType}:${tuple.objectId}`,
        },
      ],
      { authorizationModelId },
    );
    return "accepted";
  } catch (error) {
    const refusal = refusalOf(error);
    if (!refusal) throw error;
    return refusal.code === "write_failed_due_to_invalid_input"
      ? "missing"
      : "refused";
  }
}

/**
 * Write a model given as JSON and return its id.
 *
 * `fgaWriteModel` reads a DSL file; this takes the request
 * directly, for a suite whose models are shapes the DSL cannot
 * express or whose point is the model changing under a fixture.
 */
export async function fgaWriteModelJson(
  storeId: string,
  model: WriteAuthorizationModelRequest,
): Promise<string> {
  const client = createClient(storeId);
  const response = await client.writeAuthorizationModel(model);
  return response.authorization_model_id;
}
