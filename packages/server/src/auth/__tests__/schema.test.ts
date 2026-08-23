import { describe, expect, test } from "bun:test";

/**
 * Migration 7 carries better-auth's generated schema, so it can drift from what the
 * library expects the moment a plugin is upgraded -- and the failure would be a runtime
 * "no such column" on someone's first sign-in after a deploy.
 *
 * This asks better-auth's own migrator what it would create against our database. An
 * empty answer means our SQL is exactly what it wants. Anything else names the missing
 * table or column, and the fix is a new migration, never an edit to migration 7.
 */
describe("auth schema", () => {
  test("migration 7 is what better-auth expects", async () => {
    const { auth } = await import("../auth.ts");
    const { getMigrations } = await import("better-auth/db/migration");

    const migrations = await getMigrations(auth.options);

    expect(migrations.toBeCreated.map((t) => t.table)).toEqual([]);
    expect(migrations.toBeAdded.map((t) => t.table)).toEqual([]);
  });
});
