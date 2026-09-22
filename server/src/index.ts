import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDb } from "./db/client";
import { buildApp } from "./app";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const migrationPool = new Pool({ connectionString: databaseUrl });
  await migrate(drizzle(migrationPool), { migrationsFolder: "./drizzle" });
  await migrationPool.end();

  const db = createDb(databaseUrl);
  const app = buildApp(db);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error("[repro-server] failed to start:", error);
  process.exit(1);
});
