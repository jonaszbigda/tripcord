import path from "node:path";
import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { buildApp } from "./app";
import { loadDashboardConfig } from "./config";
import { scheduleCleanup } from "./retention";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  // dist/index.js → server/dist → repo root → dashboard/dist (same layout in the Docker image).
  const dashboard = loadDashboardConfig(process.env, path.join(__dirname, "..", "..", "dashboard", "dist"));

  await runMigrations(databaseUrl);

  const db = createDb(databaseUrl);
  const app = await buildApp(db, {
    rateLimitMax: process.env.RATE_LIMIT_MAX ? Number(process.env.RATE_LIMIT_MAX) : undefined,
    rateLimitWindow: process.env.RATE_LIMIT_WINDOW,
    bodyLimit: process.env.BODY_LIMIT_BYTES ? Number(process.env.BODY_LIMIT_BYTES) : undefined,
    logLevel: process.env.LOG_LEVEL,
    publicUrl: dashboard.publicUrl,
    signup: dashboard.signup,
    github: dashboard.github,
    trustProxy: dashboard.trustProxy,
    dashboardDir: dashboard.dashboardDir,
  });

  const retentionDays = process.env.RETENTION_DAYS ? Number(process.env.RETENTION_DAYS) : 30;
  scheduleCleanup(db, retentionDays);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error("[tripcord-server] failed to start:", error);
  process.exit(1);
});
