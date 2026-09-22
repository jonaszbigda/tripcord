import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { runCli } from "./admin";

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    return 1;
  }

  // Lets `project create` work against a fresh database before the server has booted.
  await runMigrations(databaseUrl);

  const db = createDb(databaseUrl);
  try {
    return await runCli(process.argv.slice(2), db, {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    });
  } finally {
    await db.$client.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
