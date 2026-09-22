import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestProject, getTestDb, resetDb } from "../../test/db";
import { hashApiKey } from "../keys";
import { apiKeys } from "./schema";
import { createProject, findProjectByApiKey } from "./projects";

describe("createProject", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates the project and returns a plaintext rpk_ key", async () => {
    const db = getTestDb();
    const { project, key } = await createProject(db, "widgets-inc");

    expect(project.name).toBe("widgets-inc");
    expect(key).toMatch(/^rpk_[A-Za-z0-9_-]{43}$/);
  });

  it("stores only the hash and display prefix, never the plaintext key", async () => {
    const db = getTestDb();
    const { project, key } = await createProject(db, "widgets-inc");

    const rows = await db.select().from(apiKeys).where(eq(apiKeys.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].keyHash).toBe(hashApiKey(key));
    expect(rows[0].prefix).toBe(key.slice(0, 12));
    expect(rows[0].revokedAt).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain(key);
  });

  it("allows two projects with the same name", async () => {
    const db = getTestDb();
    const first = await createProject(db, "web");
    const second = await createProject(db, "web");
    expect(first.project.id).not.toBe(second.project.id);
  });
});

describe("findProjectByApiKey", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns the project for a valid key", async () => {
    const db = getTestDb();
    const { project, key } = await createTestProject(db, "widgets-inc");

    const found = await findProjectByApiKey(db, key);

    expect(found?.id).toBe(project.id);
    expect(found?.name).toBe("widgets-inc");
  });

  it("returns undefined for an unknown key", async () => {
    const db = getTestDb();
    await createTestProject(db);
    expect(await findProjectByApiKey(db, "rpk_no-such-key")).toBeUndefined();
  });

  it("returns undefined for a revoked key", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.keyHash, hashApiKey(key)));

    expect(await findProjectByApiKey(db, key)).toBeUndefined();
  });
});
