import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client";
import { apiKeys, projects, type ApiKey, type Project } from "./schema";
import { generateApiKey, hashApiKey } from "../keys";

export interface CreatedProject {
  project: Project;
  /** Plaintext key — returned once, never stored. */
  key: string;
}

/** A key as it may be shown to users — everything except the hash. */
export type ApiKeySummary = Pick<ApiKey, "id" | "projectId" | "prefix" | "createdAt" | "revokedAt">;

export interface CreatedApiKey {
  apiKey: ApiKeySummary;
  /** Plaintext key — returned once, never stored. */
  key: string;
}

export interface ProjectSummary extends Project {
  activeKeyCount: number;
}

export interface RevokedApiKey {
  apiKey: ApiKeySummary;
  /** True when the key was already revoked; `apiKey.revokedAt` is then the original time. */
  alreadyRevoked: boolean;
}

const apiKeySummaryColumns = {
  id: apiKeys.id,
  projectId: apiKeys.projectId,
  prefix: apiKeys.prefix,
  createdAt: apiKeys.createdAt,
  revokedAt: apiKeys.revokedAt,
};

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

export async function createApiKey(db: Database, projectId: string): Promise<CreatedApiKey | undefined> {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) {
    return undefined;
  }
  const generated = generateApiKey();
  const [apiKey] = await db
    .insert(apiKeys)
    .values({ projectId, keyHash: generated.hash, prefix: generated.prefix })
    .returning(apiKeySummaryColumns);
  return { apiKey, key: generated.key };
}

export async function listProjects(db: Database): Promise<ProjectSummary[]> {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      createdAt: projects.createdAt,
      activeKeyCount: sql<number>`count(${apiKeys.id}) filter (where ${apiKeys.revokedAt} is null)`.mapWith(Number),
    })
    .from(projects)
    .leftJoin(apiKeys, eq(apiKeys.projectId, projects.id))
    .groupBy(projects.id)
    .orderBy(asc(projects.createdAt));
}

export async function listApiKeys(db: Database, projectId: string): Promise<ApiKeySummary[]> {
  return db
    .select(apiKeySummaryColumns)
    .from(apiKeys)
    .where(eq(apiKeys.projectId, projectId))
    .orderBy(asc(apiKeys.createdAt));
}

export async function revokeApiKey(db: Database, keyId: string): Promise<RevokedApiKey | undefined> {
  // Only stamp keys that aren't revoked yet, so a repeat revoke keeps the original time.
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning(apiKeySummaryColumns);
  if (revoked) {
    return { apiKey: revoked, alreadyRevoked: false };
  }
  const [existing] = await db.select(apiKeySummaryColumns).from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
  return existing ? { apiKey: existing, alreadyRevoked: true } : undefined;
}
