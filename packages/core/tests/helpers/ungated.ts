import type {
  AddTupleRequest,
  GatedRelationConfig,
  GatedTuple,
  RelationConfig,
} from "../../src/index.ts";

/**
 * Reach a store's write methods without going through the gate.
 *
 * `insertTuple` and `upsertRelationConfig` take branded arguments
 * so a consumer cannot write past `addTuple` and
 * `writeRelationConfig`. These tests exist precisely to write past
 * them — that is what a store-trust test *is* — so they say so,
 * here, once, by name.
 *
 * Deliberately a local test helper rather than an exported mint.
 * An exported one would make the gate a convention: any consumer
 * could spell the same call and be back where they started.
 */
export function ungatedTuple(tuple: AddTupleRequest): GatedTuple {
  return tuple as GatedTuple;
}

export function ungatedConfig(config: RelationConfig): GatedRelationConfig {
  return config as GatedRelationConfig;
}
