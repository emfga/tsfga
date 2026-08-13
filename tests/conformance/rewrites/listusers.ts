import { OpenFgaClient } from "@openfga/sdk";

/**
 * OpenFGA's ListUsers, reduced to the shape tsfga's `listSubjects`
 * reports.
 *
 * A local binding rather than an addition to
 * `tests/conformance/helpers/openfga.ts`, which this effort's
 * agents may not edit. It exists only so `listSubjects` has
 * something upstream to be compared against; see
 * `list-subjects.test.ts` for why the comparison is bounded.
 */
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
  },
): Promise<ListUsersEntry[]> {
  const client = new OpenFgaClient({
    apiUrl: process.env.FGA_API_URL,
    storeId,
  });
  const response = await client.listUsers(
    {
      object: { type: params.objectType, id: params.objectId },
      relation: params.relation,
      user_filters: params.filters,
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
        subjectRelation: user.userset.relation,
      };
    }
    if (user.object) {
      return {
        subjectType: user.object.type,
        subjectId: user.object.id,
        subjectRelation: null,
      };
    }
    throw new Error(`ListUsers returned an entry of no known shape`);
  });
}

/** A stable, comparable rendering of one subject. */
export function renderSubject(entry: ListUsersEntry): string {
  return entry.subjectRelation
    ? `${entry.subjectType}:${entry.subjectId}#${entry.subjectRelation}`
    : `${entry.subjectType}:${entry.subjectId}`;
}
