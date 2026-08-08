import type { RelationConfig, Tuple } from "../../src/types.ts";
import { MockTupleStore } from "./mock-store.ts";

/**
 * Error raised by the stores below. A plain `Error` subclass, not
 * a `TsfgaError`: these stand in for a backend failure (dropped
 * connection, timeout), which the check algorithm propagates
 * without interpreting.
 */
export class StoreReadFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreReadFailure";
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A non-cycle error source for the error-semantics suites.
 *
 * Those suites assert contracts about *any* failing branch — a
 * sibling `true` beats an error, exclusion and intersection fail
 * closed, a definitive deny short-circuits past an error. They
 * used to raise those errors by wiring a cyclic relation, which
 * was convenient but coupled them to what a cycle means. It does
 * not mean "error" in OpenFGA: a cycle resolves to `false` with
 * an internal flag, and only depth exhaustion is an error. A
 * store-level read failure keeps every contract under test and
 * drops the coupling, so cycle semantics can be corrected without
 * rewriting suites that were never about cycles.
 *
 * Tests that are genuinely about cycles or about depth exhaustion
 * still use those directly.
 */
export class ConfigErrorStore extends MockTupleStore {
  /**
   * @param erringRelations relations whose config read rejects
   * @param delayMs how long to stall before rejecting, for tests
   *   that need the failure to land after a sibling settles
   */
  constructor(
    private readonly erringRelations: readonly string[],
    private readonly delayMs = 0,
  ) {
    super();
  }

  override async findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    if (this.erringRelations.includes(relation)) {
      if (this.delayMs > 0) {
        await delay(this.delayMs);
      }
      throw new StoreReadFailure(
        `config read failed for ${objectType}.${relation}`,
      );
    }
    return super.findRelationConfig(objectType, relation);
  }
}

/**
 * Rejects the userset scan for the named relations instead of the
 * config read, so a branch can fail *after* its config resolved —
 * the other half of the node's single read wave.
 */
export class UsersetErrorStore extends MockTupleStore {
  constructor(private readonly erringRelations: readonly string[]) {
    super();
  }

  override async findUsersetTuples(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]> {
    if (this.erringRelations.includes(relation)) {
      throw new StoreReadFailure(
        `userset scan failed for ${objectType}.${relation}`,
      );
    }
    return super.findUsersetTuples(objectType, objectId, relation);
  }
}
