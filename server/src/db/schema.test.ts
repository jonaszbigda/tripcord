import { describe, it, expect } from "vitest";
import { getTestDb } from "../../test/db";
import { projects } from "./schema";

describe("schema wiring", () => {
  it("can insert a project and read it back", async () => {
    const db = getTestDb();

    const [inserted] = await db
      .insert(projects)
      .values({ name: "test project", apiKey: "test-key-123" })
      .returning();

    const found = await db.query.projects.findFirst({
      where: (p, { eq }) => eq(p.id, inserted.id),
    });

    expect(found?.name).toBe("test project");
    expect(found?.apiKey).toBe("test-key-123");
  });
});
