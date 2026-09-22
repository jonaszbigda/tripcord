import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// Shared by the server and the admin CLI. Drizzle skips migrations that are
// already applied, so running this from both entrypoints is safe.
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), {
      // src/db/migrate.ts and dist/db/migrate.js both sit two levels below server/.
      migrationsFolder: path.join(__dirname, "..", "..", "drizzle"),
    });
  } finally {
    await pool.end();
  }
}
