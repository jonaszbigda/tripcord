import { inject } from "vitest";
import { createDb, type Database } from "../src/db/client";
import {
  apiKeys,
  invites,
  memberships,
  orgs,
  projects,
  sessions,
  timelines,
  users,
  type Org,
  type User,
} from "../src/db/schema";
import { createProject, type CreatedProject } from "../src/db/projects";
import { createOrg } from "../src/db/orgs";

// One pool per test file: Vitest isolates each file's module graph, so this is
// reset between files, and the connections close when the file's worker exits.
let testDb: Database | undefined;

export function getTestDb(): Database {
  testDb ??= createDb(inject("databaseUrl"));
  return testDb;
}

// Deletes in foreign-key order: children before the rows they reference.
export async function resetDb(db: Database): Promise<void> {
  await db.delete(timelines);
  await db.delete(apiKeys);
  await db.delete(projects);
  await db.delete(invites);
  await db.delete(sessions);
  await db.delete(memberships);
  await db.delete(orgs);
  await db.delete(users);
}

export async function createTestOrg(db: Database, name = "Acme"): Promise<Org> {
  return createOrg(db, name);
}

export async function createTestProject(db: Database, name = "acme", orgId?: string): Promise<CreatedProject> {
  return createProject(db, orgId ?? (await createTestOrg(db)).id, name);
}

let rowSeq = 0;

// Bare user row with no password. Task 3 adds createTestUser, the one tests
// normally use.
export async function createTestUserRow(db: Database): Promise<User> {
  rowSeq += 1;
  const [user] = await db
    .insert(users)
    .values({ email: `row${rowSeq}@example.com`, name: `Row ${rowSeq}` })
    .returning();
  return user;
}
