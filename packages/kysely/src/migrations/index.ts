import type { Migration, MigrationProvider } from "kysely/migration";
import * as initial from "./001-initial.ts";
import * as addOperators from "./002-add-operators.ts";
import * as dropUnusedIndexes from "./003-drop-unused-indexes.ts";
import * as dropMetadataColumns from "./004-drop-metadata-columns.ts";
import * as typeRestrictions from "./005-type-restrictions.ts";

/**
 * All tsfga schema migrations, keyed by name in execution order.
 * Keys sort lexicographically, matching Kysely's migration
 * ordering requirements.
 */
export const migrations: Record<string, Migration> = {
  "001-initial": initial,
  "002-add-operators": addOperators,
  "003-drop-unused-indexes": dropUnusedIndexes,
  "004-drop-metadata-columns": dropMetadataColumns,
  "005-type-restrictions": typeRestrictions,
};

/**
 * A Kysely MigrationProvider backed by the bundled migrations.
 * Client applications provision or upgrade the tsfga schema with:
 *
 * ```ts
 * import { Migrator } from "kysely/migration";
 * import { migrationProvider } from "@tsfga/kysely/migrations";
 *
 * const migrator = new Migrator({ db, provider: migrationProvider });
 * await migrator.migrateToLatest();
 * ```
 *
 * Static (no filesystem scanning), so it works in bundlers and
 * any runtime.
 */
export const migrationProvider: MigrationProvider = {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations);
  },
};
