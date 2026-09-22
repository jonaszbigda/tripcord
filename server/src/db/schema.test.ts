import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetDb } from "../../test/db";
import { apiKeys, projects } from "./schema";

describe("schema wiring", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("can insert a project with an api key row and read both back", async () => {
    const db = getTestDb();

    const [inserted] = await db.insert(projects).values({ name: "test project" }).returning();
    await db.insert(apiKeys).values({ projectId: inserted.id, keyHash: "hash-123", prefix: "rpk_prefix12" });

    const found = await db.query.projects.findFirst({
      where: (p, { eq }) => eq(p.id, inserted.id),
    });
    const key = await db.query.apiKeys.findFirst({
      where: (k, { eq }) => eq(k.projectId, inserted.id),
    });

    expect(found?.name).toBe("test project");
    expect(key?.keyHash).toBe("hash-123");
    expect(key?.revokedAt).toBeNull();
  });
});
