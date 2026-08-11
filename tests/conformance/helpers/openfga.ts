import * as fs from "node:fs";
import { OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import { parse as parseYaml } from "yaml";

const apiUrl = process.env.FGA_API_URL;

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
): Promise<boolean | null> {
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
  } catch {
    return null;
  }
}

/**
 * Write one tuple and report whether OpenFGA accepted it.
 *
 * Distinct from `fgaWriteTuples`, which reads a fixture and lets a
 * rejection throw. Here the rejection *is* the result under test,
 * so it is reported rather than raised.
 */
export async function fgaWrite(
  storeId: string,
  authorizationModelId: string,
  tuple: {
    objectType: string;
    objectId: string;
    relation: string;
    subjectType: string;
    subjectId: string;
    subjectRelation?: string | null;
    conditionName?: string | null;
    conditionContext?: Record<string, unknown> | null;
  },
): Promise<"accepted" | "refused"> {
  const client = createClient(storeId);
  const user = tuple.subjectRelation
    ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
    : `${tuple.subjectType}:${tuple.subjectId}`;
  try {
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
    return "accepted";
  } catch {
    return "refused";
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
