import type { AddTupleRequest, RelationConfig } from "./types.ts";

/**
 * The two durable write sinks, and why they are branded.
 *
 * `KyselyTupleStore` is exported with a public `insertTuple` and a
 * public `upsertRelationConfig`. A seeding script, a backfill, or
 * a migration written against `@tsfga/kysely` can therefore write
 * a row `addTuple` refuses — measured: two such rows produce
 * `check → true` for a permission no OpenFGA store can represent,
 * and it compiles today against the published package.
 *
 * Every other kind of drift is already closed on the read side:
 * `clampToQuery` re-applies the model's exact match to whatever a
 * store returns, so an adapter cannot widen what the model admits
 * on a check. This is the same idea pointed at the write side, and
 * the same sentence explains both — *a store is where data lives,
 * not where the model is decided.*
 *
 * A brand rather than a runtime check because there is nothing to
 * check at the sink: the argument's *shape* is fine, and what
 * makes it legal is that it went through the validator, which the
 * value cannot carry evidence of. The compiler can carry it.
 *
 * ## What this does not do, stated plainly
 *
 * **It does not gate a third-party adapter.** TypeScript's method
 * parameters are bivariant, so a class declaring
 * `insertTuple(tuple: AddTupleRequest)` still satisfies
 * `TupleStore` — the compiler will never demand the branded type.
 * What the brand does is stop a *caller* reaching a store's write
 * methods with an unvalidated value, which is the measured hole.
 *
 * **It does not stop a determined caller**, and it is not meant
 * to. Brands erase at emit, so plain JavaScript is unaffected, and
 * anyone writing `as` gets what they asked for. It stops the
 * accidental case, which is the case that happened.
 */

declare const gated: unique symbol;

/** A tuple that has been through `addTuple`'s validation. */
export type GatedTuple = AddTupleRequest & { readonly [gated]: "tuple" };

/** A config that has been through `writeRelationConfig`'s. */
export type GatedRelationConfig = RelationConfig & {
  readonly [gated]: "config";
};

/**
 * Mint a `GatedTuple`. **Call only after `validateTupleWrite`.**
 *
 * Deliberately not exported from the package. An exported mint
 * would make the gate a convention: any consumer could write
 * `store.insertTuple(parseTupleWrite(raw))` and be exactly where
 * they started, with a spelling that reads as blessed. A test that
 * genuinely wants the store ungated declares its own four-line
 * local helper, which also names what it is doing.
 */
export function parseTupleWrite(tuple: AddTupleRequest): GatedTuple {
  // One of the two `as` assertions in the package. The brand is a
  // phantom property that no value has and none can be given, so
  // minting one is an assertion by construction -- that is what
  // makes it a boundary rather than a shape.
  return tuple as GatedTuple;
}

/**
 * Mint a `GatedRelationConfig`. **Call only after
 * `validateRelationConfigWrite`.** The second of the two.
 */
export function parseRelationConfigWrite(
  config: RelationConfig,
): GatedRelationConfig {
  return config as GatedRelationConfig;
}
