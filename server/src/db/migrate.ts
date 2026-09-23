import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// Shared by the server and the admin CLI. Drizzle skips migrations that are
// already applied, so running this from both entrypoints is safe.
// Arbitrary app-wide constant; any process migrating this database takes the same lock.
const MIGRATION_LOCK_ID = 727_401;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    // Session-level lock on the same connection that runs the migrations, so a
    // concurrent server boot and CLI run can't both apply the same migration.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await migrate(drizzle(client), {
      // src/db/migrate.ts and dist/db/migrate.js both sit two levels below server/.
      migrationsFolder: path.join(__dirname, "..", "..", "drizzle"),
    });
  } finally {
    // Releasing the connection back to a pool that's about to end closes the
    // session, which drops the lock even if unlock fails.
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}
