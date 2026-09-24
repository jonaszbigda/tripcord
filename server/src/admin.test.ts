import { describe, it, expect, beforeEach } from "vitest";
import { createTestOrg, createTestProject, createTestUser, getTestDb, resetDb } from "../test/db";
import { findProjectByApiKey, listApiKeys, listProjects, revokeApiKey } from "./db/projects";
import { runCli, USAGE } from "./admin";
import { verifyPassword } from "./auth/password";
import { createSession, findSessionUser } from "./db/sessions";
import { findUserById } from "./db/users";

const MISSING_ID = "00000000-0000-0000-0000-000000000000";
const KEY_PATTERN = /^tpk_[A-Za-z0-9_-]{43}$/;

async function run(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, getTestDb(), {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

describe("runCli", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  describe("command shape errors", () => {
    it("exits 2 with usage when no command is given", async () => {
      const result = await run([]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Missing command", USAGE]);
    });

    it("exits 2 with usage for an unknown command", async () => {
      const result = await run(["project", "delete"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Unknown command: project delete", USAGE]);
    });

    it("exits 2 with usage for a missing argument", async () => {
      const result = await run(["project", "create", "--org", MISSING_ID]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Missing argument: <name>", USAGE]);
    });

    it("exits 2 with usage for an extra argument", async () => {
      const result = await run(["project", "create", "--org", MISSING_ID, "My", "Project"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Unexpected argument: Project", USAGE]);
    });

    it("exits 2 with usage for an unknown flag", async () => {
      const result = await run(["project", "list", "--json"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toHaveLength(2);
      expect(result.stderr[0]).toContain("--json");
      expect(result.stderr[1]).toBe(USAGE);
    });
  });

  describe("help", () => {
    it.each([["--help"], ["-h"]])("prints usage to stdout and exits 0 for %s", async (flag) => {
      const result = await run([flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toEqual([USAGE]);
      expect(result.stderr).toEqual([]);
    });

    it("accepts a project name starting with '-' after --", async () => {
      const org = await createTestOrg(getTestDb());
      const result = await run(["project", "create", "--org", org.id, "--", "-beta"]);
      expect(result.code).toBe(0);
      const [project] = await listProjects(getTestDb());
      expect(project.name).toBe("-beta");
    });
  });

  describe("project create", () => {
    it("creates the project in the org and prints its id and a working key once", async () => {
      const org = await createTestOrg(getTestDb());
      const result = await run(["project", "create", "--org", org.id, "Acme"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toEqual([]);
      const [project] = await listProjects(getTestDb());
      expect(project.name).toBe("Acme");
      expect(project.orgId).toBe(org.id);
      expect(result.stdout[0]).toBe(`Created project "Acme" (${project.id})`);
      expect(result.stdout[1]).toMatch(KEY_PATTERN);
      expect(result.stdout[2]).toBe("Store this API key now. It will not be shown again.");
      expect((await findProjectByApiKey(getTestDb(), result.stdout[1]))?.id).toBe(project.id);
    });

    it("trims the project name", async () => {
      const org = await createTestOrg(getTestDb());
      await run(["project", "create", "--org", org.id, "  Acme  "]);
      const [project] = await listProjects(getTestDb());
      expect(project.name).toBe("Acme");
    });

    it("exits 2 without usage for a whitespace-only name", async () => {
      const org = await createTestOrg(getTestDb());
      const result = await run(["project", "create", "--org", org.id, "   "]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Project name is required"]);
      expect(await listProjects(getTestDb())).toEqual([]);
    });

    it("exits 2 without usage for a name with control characters", async () => {
      const org = await createTestOrg(getTestDb());
      const result = await run(["project", "create", "--org", org.id, "Acme\x1b[2J"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Project name must not contain control characters"]);
      expect(await listProjects(getTestDb())).toEqual([]);
    });

    it("exits 2 with usage when --org is missing", async () => {
      const result = await run(["project", "create", "Acme"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Missing option: --org <orgId>", USAGE]);
    });

    it("exits 2 for a malformed org id", async () => {
      const result = await run(["project", "create", "--org", "nope", "Acme"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Invalid id: nope"]);
    });

    it("exits 1 when the org doesn't exist", async () => {
      const result = await run(["project", "create", "--org", MISSING_ID, "Acme"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toEqual([`Org not found: ${MISSING_ID}`]);
      expect(await listProjects(getTestDb())).toEqual([]);
    });

    it("rejects --org on other commands", async () => {
      const result = await run(["project", "list", "--org", MISSING_ID]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Unknown option: --org", USAGE]);
    });
  });

  describe("project list", () => {
    it("prints a message when there are no projects", async () => {
      const result = await run(["project", "list"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toEqual(["No projects."]);
    });

    it("prints a table of projects with active key counts and no keys", async () => {
      const { project, key } = await createTestProject(getTestDb(), "Acme");

      const result = await run(["project", "list"]);

      expect(result.code).toBe(0);
      expect(result.stdout[0]).toMatch(/^ID\s+ORG\s+NAME\s+CREATED\s+ACTIVE KEYS$/);
      expect(result.stdout[1]).toContain(project.orgId);
      expect(result.stdout[1]).toContain(project.id);
      expect(result.stdout[1]).toContain("Acme");
      expect(result.stdout[1]).toContain(project.createdAt.toISOString());
      expect(result.stdout[1]).toMatch(/\s1$/);
      expect(result.stdout.join("\n")).not.toContain(key);
    });

    it("never prints control characters from names stored before they were rejected", async () => {
      await createTestProject(getTestDb(), "Acme\x1b[2J\nwiped");

      const result = await run(["project", "list"]);

      expect(result.stdout).toHaveLength(2);
      expect(result.stdout[1]).toContain("Acme[2Jwiped");
    });
  });

  describe("org list", () => {
    it("prints a message when there are no orgs", async () => {
      const result = await run(["org", "list"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toEqual(["No orgs."]);
    });

    it("prints orgs with member and project counts", async () => {
      const { project } = await createTestProject(getTestDb(), "web");

      const result = await run(["org", "list"]);

      expect(result.code).toBe(0);
      expect(result.stdout[0]).toMatch(/^ID\s+NAME\s+CREATED\s+MEMBERS\s+PROJECTS$/);
      expect(result.stdout[1]).toContain(project.orgId);
      expect(result.stdout[1]).toMatch(/\s0\s+1$/);
    });
  });

  describe("key create", () => {
    it("mints a new working key and prints it once", async () => {
      const { project } = await createTestProject(getTestDb());

      const result = await run(["key", "create", project.id]);

      expect(result.code).toBe(0);
      expect(result.stdout[0]).toBe(`Created API key for project ${project.id}`);
      expect(result.stdout[1]).toMatch(KEY_PATTERN);
      expect(result.stdout[2]).toBe("Store this API key now. It will not be shown again.");
      expect((await findProjectByApiKey(getTestDb(), result.stdout[1]))?.id).toBe(project.id);
    });

    it("exits 1 for a project that doesn't exist", async () => {
      const result = await run(["key", "create", MISSING_ID]);
      expect(result.code).toBe(1);
      expect(result.stderr).toEqual([`Project not found: ${MISSING_ID}`]);
    });

    it("exits 2 without usage for a malformed id", async () => {
      const result = await run(["key", "create", "not-a-uuid"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Invalid id: not-a-uuid"]);
    });
  });

  describe("key list", () => {
    it("prints prefixes and revocation times but never full keys", async () => {
      const db = getTestDb();
      const { project, key } = await createTestProject(db);
      const [summary] = await listApiKeys(db, project.id);
      const revoked = await revokeApiKey(db, summary.id);

      const result = await run(["key", "list", project.id]);

      expect(result.code).toBe(0);
      expect(result.stdout[0]).toMatch(/^ID\s+PREFIX\s+CREATED\s+REVOKED$/);
      expect(result.stdout[1]).toContain(summary.id);
      expect(result.stdout[1]).toContain(key.slice(0, 12));
      expect(result.stdout[1]).toContain(revoked!.apiKey.revokedAt!.toISOString());
      expect(result.stdout.join("\n")).not.toContain(key);
    });

    it("shows a dash for active keys", async () => {
      const { project } = await createTestProject(getTestDb());
      const result = await run(["key", "list", project.id]);
      expect(result.stdout[1]).toMatch(/\s-$/);
    });

    it("prints a message when the project has no keys", async () => {
      const result = await run(["key", "list", MISSING_ID]);
      expect(result.code).toBe(0);
      expect(result.stdout).toEqual(["No API keys."]);
    });

    it("exits 2 without usage for a malformed id", async () => {
      const result = await run(["key", "list", "nope"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Invalid id: nope"]);
    });
  });

  describe("key revoke", () => {
    it("revokes the key", async () => {
      const db = getTestDb();
      const { project, key } = await createTestProject(db);
      const [summary] = await listApiKeys(db, project.id);

      const result = await run(["key", "revoke", summary.id]);

      expect(result.code).toBe(0);
      expect(result.stdout).toEqual([`Revoked key ${summary.prefix} (${summary.id})`]);
      expect(await findProjectByApiKey(db, key)).toBeUndefined();
    });

    it("exits 0 and reports the original time when already revoked", async () => {
      const db = getTestDb();
      const { project } = await createTestProject(db);
      const [summary] = await listApiKeys(db, project.id);
      const first = await revokeApiKey(db, summary.id);

      const result = await run(["key", "revoke", summary.id]);

      expect(result.code).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(result.stdout).toEqual([
        `Key ${summary.prefix} already revoked at ${first!.apiKey.revokedAt!.toISOString()}`,
      ]);
    });

    it("exits 1 for an unknown key", async () => {
      const result = await run(["key", "revoke", MISSING_ID]);
      expect(result.code).toBe(1);
      expect(result.stderr).toEqual([`Key not found: ${MISSING_ID}`]);
    });

    it("exits 2 without usage for a malformed id", async () => {
      const result = await run(["key", "revoke", "123"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Invalid id: 123"]);
    });
  });

  describe("user reset-password", () => {
    it("sets a new password, prints it once, and logs the user out everywhere", async () => {
      const db = getTestDb();
      const user = await createTestUser(db, { email: "ana@example.com", password: "old-password" });
      const { token } = await createSession(db, user.id);

      const result = await run(["user", "reset-password", "ANA@example.com"]);

      expect(result.code).toBe(0);
      expect(result.stdout[0]).toBe("Reset password for ana@example.com");
      expect(result.stdout[1]).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(result.stdout[2]).toBe("Store this password now. It will not be shown again. The user was logged out everywhere.");
      const updated = await findUserById(db, user.id);
      expect(await verifyPassword(result.stdout[1], updated!.passwordHash!)).toBe(true);
      expect(await findSessionUser(db, token)).toBeUndefined();
    });

    it("exits 1 for an unknown email", async () => {
      const result = await run(["user", "reset-password", "nobody@example.com"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toEqual(["User not found: nobody@example.com"]);
    });
  });
});
