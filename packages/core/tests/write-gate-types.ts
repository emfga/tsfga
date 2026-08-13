import type {
  AddTupleRequest,
  RelationConfig,
  TupleStore,
} from "../src/index.ts";

/**
 * What the write brands do and do not stop, asserted by the
 * compiler rather than at runtime.
 *
 * `.ts` rather than `.test.ts` **on purpose**: `bun run tsc`
 * type-checks it and the Bun, Node and Deno test globs do not
 * pick it up. There is nothing here to run — a brand erases at
 * emit, so every claim in this file is a claim about
 * type-checking and about nothing else.
 *
 * The two negative cases are written as `@ts-expect-error`, which
 * fails the build if the error stops happening. That is the
 * direction that matters: the gate closing is what would go
 * unnoticed.
 */

declare const store: TupleStore;
declare const tuple: AddTupleRequest;
declare const config: RelationConfig;

// @ts-expect-error an unvalidated tuple cannot reach the sink
void store.insertTuple(tuple);

// @ts-expect-error nor can an unvalidated relation config
void store.upsertRelationConfig(config);

/**
 * And the limit, stated as code so it cannot be forgotten: method
 * parameters are **bivariant** in TypeScript, so a store
 * declaring the unbranded parameter still satisfies `TupleStore`.
 * The compiler will never demand the brand of an adapter author.
 *
 * That is not a hole this can close; it is what the language
 * does. What the brand closes is the measured case — a *caller*
 * reaching a store's write methods around `addTuple`.
 */
class UnbrandedStore {
  insertTuple(_tuple: AddTupleRequest): Promise<boolean> {
    return Promise.resolve(true);
  }
  upsertRelationConfig(_config: RelationConfig): Promise<void> {
    return Promise.resolve();
  }
}

declare const unbranded: UnbrandedStore;
// Bivariance: this assignment is legal, and it is the whole
// third-party-adapter caveat in one line.
const _acceptsUnbranded: Pick<
  TupleStore,
  "insertTuple" | "upsertRelationConfig"
> = unbranded;
void _acceptsUnbranded;
