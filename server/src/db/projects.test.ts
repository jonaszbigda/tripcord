import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestProject, getTestDb, resetDb } from "../../test/db";
import { hashApiKey } from "../keys";
import { apiKeys, projects } from "./schema";
import {
  createApiKey,
  createProject,
  findProjectByApiKey,
  listApiKeys,
  listProjects,
  revokeApiKey,
} from "./projects";

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

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

describe("createApiKey", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("mints an additional key; old and new keys both resolve to the project", async () => {
    const db = getTestDb();
    const { project, key: firstKey } = await createTestProject(db);

    const created = await createApiKey(db, project.id);

    expect(created).toBeDefined();
    expect(created!.key).not.toBe(firstKey);
    expect(created!.apiKey.projectId).toBe(project.id);
    expect(created!.apiKey.prefix).toBe(created!.key.slice(0, 12));
    expect((await findProjectByApiKey(db, firstKey))?.id).toBe(project.id);
    expect((await findProjectByApiKey(db, created!.key))?.id).toBe(project.id);
  });

  it("returns undefined for a project that doesn't exist", async () => {
    const db = getTestDb();
    expect(await createApiKey(db, MISSING_ID)).toBeUndefined();
    expect(await db.select().from(apiKeys)).toHaveLength(0);
  });

  it("never returns the stored hash", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    const created = await createApiKey(db, project.id);
    expect(created!.apiKey).not.toHaveProperty("keyHash");
  });
});

describe("listProjects", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns an empty list when there are no projects", async () => {
    expect(await listProjects(getTestDb())).toEqual([]);
  });

  it("counts only active keys, including projects with none active", async () => {
    const db = getTestDb();
    const { project: alpha } = await createTestProject(db, "alpha");
    await createApiKey(db, alpha.id);
    const { project: beta } = await createTestProject(db, "beta");
    const [betaKey] = await listApiKeys(db, beta.id);
    await revokeApiKey(db, betaKey.id);

    const result = await listProjects(db);

    expect(result.map((p) => [p.name, p.activeKeyCount])).toEqual([
      ["alpha", 2],
      ["beta", 0],
    ]);
    expect(result[0].id).toBe(alpha.id);
    expect(result[0].createdAt).toBeInstanceOf(Date);
  });

  it("reports zero active keys for a project that never had a key (pre-upgrade project)", async () => {
    const db = getTestDb();
    const [legacy] = await db.insert(projects).values({ name: "legacy" }).returning();

    const result = await listProjects(db);

    expect(result).toEqual([
      { id: legacy.id, name: "legacy", createdAt: legacy.createdAt, activeKeyCount: 0 },
    ]);
  });
});

describe("listApiKeys", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("lists a project's keys oldest first, without hashes", async () => {
    const db = getTestDb();
    const { project, key: firstKey } = await createTestProject(db);
    const second = await createApiKey(db, project.id);
    await createTestProject(db, "other"); // must not appear

    const keys = await listApiKeys(db, project.id);

    expect(keys.map((k) => k.prefix)).toEqual([firstKey.slice(0, 12), second!.key.slice(0, 12)]);
    for (const k of keys) {
      expect(k).not.toHaveProperty("keyHash");
      expect(k.revokedAt).toBeNull();
    }
  });

  it("returns an empty list for an unknown project", async () => {
    expect(await listApiKeys(getTestDb(), MISSING_ID)).toEqual([]);
  });
});

describe("revokeApiKey", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("revokes a key so it no longer authenticates", async () => {
    const db = getTestDb();
    const { project, key } = await createTestProject(db);
    const [summary] = await listApiKeys(db, project.id);

    const result = await revokeApiKey(db, summary.id);

    expect(result?.alreadyRevoked).toBe(false);
    expect(result?.apiKey.id).toBe(summary.id);
    expect(result?.apiKey.revokedAt).toBeInstanceOf(Date);
    expect(await findProjectByApiKey(db, key)).toBeUndefined();
  });

  it("is idempotent and keeps the original revokedAt", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    const [summary] = await listApiKeys(db, project.id);

    const first = await revokeApiKey(db, summary.id);
    const second = await revokeApiKey(db, summary.id);

    expect(second?.alreadyRevoked).toBe(true);
    expect(second?.apiKey.revokedAt?.getTime()).toBe(first?.apiKey.revokedAt?.getTime());
  });

  it("leaves the project's other keys working", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    const [oldKey] = await listApiKeys(db, project.id);
    const replacement = await createApiKey(db, project.id);

    await revokeApiKey(db, oldKey.id);

    expect((await findProjectByApiKey(db, replacement!.key))?.id).toBe(project.id);
  });

  it("returns undefined for an unknown key id", async () => {
    expect(await revokeApiKey(getTestDb(), MISSING_ID)).toBeUndefined();
  });
});
