import { describe, it, expect, inject } from "vitest";
import { runMigrations } from "./migrate";

describe("runMigrations", () => {
  it("resolves the migrations folder and is a no-op on an already-migrated database", async () => {
    // globalSetup has already applied every migration to this database.
    await expect(runMigrations(inject("databaseUrl"))).resolves.toBeUndefined();
  });

  it("allows concurrent runs (serialized by an advisory lock)", async () => {
    const url = inject("databaseUrl");
    await expect(Promise.all([runMigrations(url), runMigrations(url)])).resolves.toEqual([undefined, undefined]);
  });
});
