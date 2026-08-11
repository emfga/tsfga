import * as fs from "node:fs";
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

export async function fgaCreateStore(name: string): Promise<string> {
  const client = createClient();
  const response = await client.createStore({ name });
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
  const uuid = uuidMap.get(name);
  if (!uuid) return ref;

  return `${type}:${uuid}${suffix}`;
}

export interface FgaContextualTuple {
  user: string;
  relation: string;
  object: string;
}

export interface FgaCheckParams {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
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
        user: `${params.subjectType}:${params.subjectId}`,
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
