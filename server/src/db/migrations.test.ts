import { describe, it, expect, inject } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const MIGRATIONS = path.join(__dirname, "..", "..", "drizzle");

// A copy of the migrations folder whose journal stops before migration `idx`.
function migrationsBefore(idx: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "repro-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx < idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

// Runs `fn` against a brand-new database in the shared test container, so the
// migrations can be applied from scratch without disturbing other tests.
async function withFreshDatabase(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const adminUrl = inject("databaseUrl");
  const name = `migration_test_${Date.now()}`;
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  try {
    await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
}

describe("org migration (0002)", () => {
  it("moves projects that existed before orgs into a single Default org", async () => {
    await withFreshDatabase(async (pool) => {
      const db = drizzle(pool);
      const before = migrationsBefore(2);
      try {
        await migrate(db, { migrationsFolder: before });
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
      await pool.query(`INSERT INTO projects (name) VALUES ('legacy-a'), ('legacy-b')`);

      await migrate(db, { migrationsFolder: MIGRATIONS });

      const orgs = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM orgs`);
      expect(orgs.rows).toHaveLength(1);
      expect(orgs.rows[0].name).toBe("Default");
      const projects = await pool.query<{ org_id: string }>(`SELECT org_id FROM projects ORDER BY name`);
      expect(projects.rows.map((row) => row.org_id)).toEqual([orgs.rows[0].id, orgs.rows[0].id]);
    });
  });

  it("creates no org on an empty database and leaves projects.org_id NOT NULL", async () => {
    await withFreshDatabase(async (pool) => {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

      const orgs = await pool.query(`SELECT 1 FROM orgs`);
      expect(orgs.rows).toHaveLength(0);
      const column = await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'org_id'`
      );
      expect(column.rows[0].is_nullable).toBe("NO");
    });
  });
});

describe("tags migration (0003)", () => {
  it("gives existing timelines an empty tags array", async () => {
    await withFreshDatabase(async (pool) => {
      const db = drizzle(pool);
      const before = migrationsBefore(3);
      try {
        await migrate(db, { migrationsFolder: before });
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
      const org = await pool.query<{ id: string }>(`INSERT INTO orgs (name) VALUES ('o') RETURNING id`);
      const project = await pool.query<{ id: string }>(
        `INSERT INTO projects (org_id, name) VALUES ($1, 'p') RETURNING id`,
        [org.rows[0].id]
      );
      await pool.query(
        `INSERT INTO timelines (project_id, session_id, reason_type, reason, events, meta)
         VALUES ($1, 's', 'manual', '{"type":"manual"}', '[]', '{"url":"u","userAgent":"a","capturedAt":1}')`,
        [project.rows[0].id]
      );

      await migrate(db, { migrationsFolder: MIGRATIONS });

      const rows = await pool.query<{ tags: string[] }>(`SELECT tags FROM timelines`);
      expect(rows.rows).toEqual([{ tags: [] }]);
    });
  });
});
