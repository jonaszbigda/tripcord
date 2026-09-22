import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "./client";
import { apiKeys, projects, type Project } from "./schema";
import { generateApiKey, hashApiKey } from "../keys";

export interface CreatedProject {
  project: Project;
  /** Plaintext key — returned once, never stored. */
  key: string;
}

export async function createProject(db: Database, name: string): Promise<CreatedProject> {
  return db.transaction(async (tx) => {
    const [project] = await tx.insert(projects).values({ name }).returning();
    const generated = generateApiKey();
    await tx.insert(apiKeys).values({
      projectId: project.id,
      keyHash: generated.hash,
      prefix: generated.prefix,
    });
    return { project, key: generated.key };
  });
}

// Revoked and unknown keys are indistinguishable here on purpose, so ingest
// returns the same 401 for both and never reveals that a key once existed.
export async function findProjectByApiKey(db: Database, key: string): Promise<Project | undefined> {
  const [found] = await db
    .select({ project: projects })
    .from(apiKeys)
    .innerJoin(projects, eq(apiKeys.projectId, projects.id))
    .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)))
    .limit(1);
  return found?.project;
}
