import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { runCli } from "./admin";
import { loadDashboardConfig } from "./config";
import { createSmtpMailer } from "./email";

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    return 1;
  }

  // Lets `project create` work against a fresh database before the server has booted.
  await runMigrations(databaseUrl);

  // The same configuration the server reads, for invite links and email.
  const config = loadDashboardConfig(process.env, "");
  const deps = { publicUrl: config.publicUrl, mailer: config.email ? createSmtpMailer(config.email) : undefined };

  const db = createDb(databaseUrl);
  try {
    const out = {
      stdout: (line: string) => console.log(line),
      stderr: (line: string) => console.error(line),
    };
    return await runCli(process.argv.slice(2), db, out, deps);
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
