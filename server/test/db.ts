import { inject } from "vitest";
import { createDb, type Database } from "../src/db/client";
import { apiKeys, projects, timelines } from "../src/db/schema";
import { createProject, type CreatedProject } from "../src/db/projects";

export function getTestDb(): Database {
  return createDb(inject("databaseUrl"));
}

// Deletes in foreign-key order: timelines and api_keys both reference projects.
export async function resetDb(db: Database): Promise<void> {
  await db.delete(timelines);
  await db.delete(apiKeys);
  await db.delete(projects);
}

export async function createTestProject(db: Database, name = "acme"): Promise<CreatedProject> {
  return createProject(db, name);
}
