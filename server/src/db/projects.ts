import { eq } from "drizzle-orm";
import type { Database } from "./client";
import { projects, type Project } from "./schema";

export async function findProjectByApiKey(db: Database, apiKey: string): Promise<Project | undefined> {
  const [found] = await db.select().from(projects).where(eq(projects.apiKey, apiKey)).limit(1);
  return found;
}
