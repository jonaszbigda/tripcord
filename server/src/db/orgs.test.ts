import { describe, it, expect, beforeEach } from "vitest";
import { createTestOrg, createTestProject, createTestUserRow, getTestDb, resetDb } from "../../test/db";
import { memberships } from "./schema";
import { createOrg, findOrg, listOrgs } from "./orgs";

describe("orgs", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates and finds an org", async () => {
    const db = getTestDb();
    const org = await createOrg(db, "Acme");
    expect(org.name).toBe("Acme");
    expect((await findOrg(db, org.id))?.id).toBe(org.id);
    expect(await findOrg(db, "00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("lists orgs oldest first with member and project counts", async () => {
    const db = getTestDb();
    const acme = await createTestOrg(db, "Acme");
    const empty = await createTestOrg(db, "Empty");
    await createTestProject(db, "web", acme.id);
    await createTestProject(db, "api", acme.id);
    const user = await createTestUserRow(db);
    await db.insert(memberships).values({ orgId: acme.id, userId: user.id, role: "owner" });

    const result = await listOrgs(db);

    expect(result.map((o) => [o.id, o.name, o.memberCount, o.projectCount])).toEqual([
      [acme.id, "Acme", 1, 2],
      [empty.id, "Empty", 0, 0],
    ]);
  });
});
