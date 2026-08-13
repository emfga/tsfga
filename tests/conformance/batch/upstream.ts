import { OpenFgaClient } from "@openfga/sdk";

/**
 * Upstream's BatchCheck and ListUsers, reduced to the shapes tsfga
 * reports.
 *
 * Local bindings rather than additions to
 * `tests/conformance/helpers/openfga.ts`, which this effort's
 * agents may not edit.
 */

function client(storeId: string): OpenFgaClient {
  return new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });
}

export interface BatchItem {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string | null;
  context?: Record<string, unknown>;
  /**
   * Named apart from `CheckRequest.contextualTuples` on purpose: a
   * test builds one object that both engines are asked, and the
   * two spell a contextual tuple differently — three fields here,
   * an `AddTupleRequest` there. One name for two shapes would make
   * the object un-typeable.
   */
  upstreamContextualTuples?: Array<{
    user: string;
    relation: string;
    object: string;
    condition?: { name: string; context?: Record<string, unknown> };
  }>;
}

/** One item's outcome, in the same three states tsfga has. */
export type BatchOutcome =
  | { allowed: true }
  | { allowed: false }
  | { allowed: false; error: string };

/**
 * BatchCheck, answered in request order.
 *
 * The SDK returns an unordered array keyed by correlation id, so
 * the index is sent as the id and the reply re-sorted by it —
 * exactly the correlation tsfga's array position is.
 *
 * A refusal of the *whole* request (rather than of one item) is
 * reported as `"request refused"` against every slot, so a caller
 * can tell "upstream isolated the failure" from "upstream refused
 * the batch".
 */
export async function fgaBatchCheck(
  storeId: string,
  authorizationModelId: string,
  items: readonly BatchItem[],
): Promise<BatchOutcome[]> {
  const checks = items.map((item, index) => ({
    user: item.subjectRelation
      ? `${item.subjectType}:${item.subjectId}#${item.subjectRelation}`
      : `${item.subjectType}:${item.subjectId}`,
    relation: item.relation,
    object: `${item.objectType}:${item.objectId}`,
    correlationId: `c${index}`,
    ...(item.context ? { context: item.context } : {}),
    ...(item.upstreamContextualTuples
      ? { contextualTuples: { tuple_keys: item.upstreamContextualTuples } }
      : {}),
  }));

  let response: Awaited<ReturnType<OpenFgaClient["batchCheck"]>>;
  try {
    response = await client(storeId).batchCheck(
      { checks },
      { authorizationModelId },
    );
  } catch (error) {
    return items.map(() => ({
      allowed: false,
      error: `request refused: ${(error as Error).message}`,
    }));
  }

  const byId = new Map(
    response.result.map((entry) => [entry.correlationId, entry]),
  );
  return items.map((_, index) => {
    const entry = byId.get(`c${index}`);
    if (!entry) return { allowed: false, error: "no outcome returned" };
    if (entry.error) {
      return { allowed: false, error: JSON.stringify(entry.error) };
    }
    return entry.allowed ? { allowed: true } : { allowed: false };
  });
}

export interface ListUsersEntry {
  subjectType: string;
  subjectId: string;
  subjectRelation: string | null;
}

export async function fgaListUsers(
  storeId: string,
  authorizationModelId: string,
  params: {
    objectType: string;
    objectId: string;
    relation: string;
    filters: Array<{ type: string; relation?: string }>;
    context?: Record<string, unknown>;
  },
): Promise<ListUsersEntry[]> {
  const response = await client(storeId).listUsers(
    {
      object: { type: params.objectType, id: params.objectId },
      relation: params.relation,
      user_filters: params.filters,
      ...(params.context ? { context: params.context } : {}),
    },
    { authorizationModelId },
  );
  return (response.users ?? []).map((user) => {
    if (user.wildcard) {
      return {
        subjectType: user.wildcard.type,
        subjectId: "*",
        subjectRelation: null,
      };
    }
    if (user.userset) {
      return {
        subjectType: user.userset.type,
        subjectId: user.userset.id,
        subjectRelation: user.userset.relation ?? null,
      };
    }
    if (user.object) {
      return {
        subjectType: user.object.type,
        subjectId: user.object.id,
        subjectRelation: null,
      };
    }
    throw new Error("ListUsers returned an entry of no known shape");
  });
}

/** A stable, comparable rendering of one subject. */
export function renderSubject(entry: ListUsersEntry): string {
  return entry.subjectRelation
    ? `${entry.subjectType}:${entry.subjectId}#${entry.subjectRelation}`
    : `${entry.subjectType}:${entry.subjectId}`;
}
