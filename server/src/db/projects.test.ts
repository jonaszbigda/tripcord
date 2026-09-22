import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb } from "../../test/db";
import { projects, timelines } from "./schema";
import { findProjectByApiKey } from "./projects";

describe("findProjectByApiKey", () => {
  beforeEach(async () => {
    const db = getTestDb();
    await db.delete(timelines);
    await db.delete(projects);
  });

  it("returns the project when the api key matches", async () => {
    const db = getTestDb();
    const [inserted] = await db
      .insert(projects)
      .values({ name: "widgets-inc", apiKey: "key-abc" })
      .returning();

    const found = await findProjectByApiKey(db, "key-abc");

    expect(found?.id).toBe(inserted.id);
    expect(found?.name).toBe("widgets-inc");
  });

  it("returns undefined when no project has that api key", async () => {
    const db = getTestDb();
    const found = await findProjectByApiKey(db, "no-such-key");
    expect(found).toBeUndefined();
  });
});
