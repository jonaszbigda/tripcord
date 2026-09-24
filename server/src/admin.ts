import { parseArgs } from "node:util";
import type { Database } from "./db/client";
import { findOrg, listOrgs } from "./db/orgs";
import { createApiKey, createProject, listApiKeys, listProjects, revokeApiKey } from "./db/projects";
import { hasControlChars, stripControlChars } from "./names";
import { isUuid } from "./uuid";
import { hashPassword } from "./auth/password";
import { generatePassword } from "./auth/tokens";
import { deleteUserSessions } from "./db/sessions";
import { findUserByEmail, normalizeEmail, setPasswordHash } from "./db/users";
import { createSignupInvite, listPendingSignupInvites, revokeSignupInvite } from "./db/invites";
import { deleteOrg, deleteUser, orgDeletionSummary, planUserDeletion, type OrgRef } from "./deletion";
import { signupInviteMail, type Mailer } from "./email";
import { EMAIL_PATTERN } from "./routes/auth";

export interface CliOutput {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const USAGE = `Usage: tripcord-admin <command>

Commands:
  org list                                List orgs
  project create --org <orgId> <name>     Create a project in an org, with its first API key
  project list                            List projects
  key create <projectId>                  Create an additional API key for a project
  key list <projectId>                    List a project's API keys
  key revoke <keyId>                      Revoke an API key
  user reset-password <email>             Set a new random password and log the user out everywhere
  user delete <email> [--yes]             Delete a user and the orgs where they're the only member
  org delete <orgId> [--yes]              Delete an org with its projects, keys and timelines
  invite create [--email <address>]       Create a signup invite (a new account with its own org); print or email its link
  invite list                             List pending signup invites
  invite revoke <inviteId>                Revoke a pending signup invite

Put -- before an argument that starts with "-", e.g. project create --org <orgId> -- -beta`;

const KEY_WARNING = "Store this API key now. It will not be shown again.";
const NOT_CONFIRMED = "Nothing deleted. Run again with --yes to delete.";

export interface CliDeps {
  /** Invite links point here. */
  publicUrl: string;
  /** Set when SMTP is configured; `invite create --email` needs it. */
  mailer?: Mailer;
}

// Which options each command accepts. --help works everywhere.
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  "project create": ["org"],
  "invite create": ["email"],
  "user delete": ["yes"],
  "org delete": ["yes"],
};

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly showUsage = false
  ) {
    super(message);
  }
}

// Returns the process exit code. Expected failures (bad input, not found) are
// reported via `out` and an exit code; anything else is thrown to the caller.
export async function runCli(
  argv: string[],
  db: Database,
  out: CliOutput,
  deps: CliDeps = { publicUrl: "http://localhost:3000" }
): Promise<number> {
  try {
    const { values, positionals } = parsePositionals(argv);
    if (values.help) {
      out.stdout(USAGE);
      return 0;
    }
    const [group, action, ...rest] = positionals;
    if (!group) {
      throw new CliError("Missing command", 2, true);
    }
    const command = `${group} ${action ?? ""}`;
    for (const option of ["org", "email", "yes"] as const) {
      if (values[option] !== undefined && !(COMMAND_OPTIONS[command] ?? []).includes(option)) {
        throw new CliError(`Unknown option: --${option}`, 2, true);
      }
    }
    switch (command) {
      case "org list":
        noArgs(rest);
        return await orgList(db, out);
      case "project create": {
        if (values.org === undefined) {
          throw new CliError("Missing option: --org <orgId>", 2, true);
        }
        const orgId = parseId(values.org);
        return await projectCreate(db, out, orgId, singleArg(rest, "<name>"));
      }
      case "project list":
        noArgs(rest);
        return await projectList(db, out);
      case "key create":
        return await keyCreate(db, out, parseId(singleArg(rest, "<projectId>")));
      case "key list":
        return await keyList(db, out, parseId(singleArg(rest, "<projectId>")));
      case "key revoke":
        return await keyRevoke(db, out, parseId(singleArg(rest, "<keyId>")));
      case "user reset-password":
        return await userResetPassword(db, out, singleArg(rest, "<email>"));
      case "user delete":
        return await userDelete(db, out, singleArg(rest, "<email>"), values.yes === true);
      case "org delete":
        return await orgDelete(db, out, parseId(singleArg(rest, "<orgId>")), values.yes === true);
      case "invite create":
        noArgs(rest);
        return await inviteCreate(db, out, deps, values.email);
      case "invite list":
        noArgs(rest);
        return await inviteList(db, out);
      case "invite revoke":
        return await inviteRevoke(db, out, parseId(singleArg(rest, "<inviteId>")));
      default:
        throw new CliError(`Unknown command: ${[group, action].filter(Boolean).join(" ")}`, 2, true);
    }
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    out.stderr(error.message);
    if (error.showUsage) {
      out.stderr(USAGE);
    }
    return error.exitCode;
  }
}

interface ParsedValues {
  help?: boolean;
  org?: string;
  email?: string;
  yes?: boolean;
}

function parsePositionals(argv: string[]): { values: ParsedValues; positionals: string[] } {
  try {
    // Strict mode still rejects any flag not listed here (e.g. --json).
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        org: { type: "string" },
        email: { type: "string" },
        yes: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 2, true);
  }
}

function singleArg(rest: string[], name: string): string {
  if (rest.length === 0) {
    throw new CliError(`Missing argument: ${name}`, 2, true);
  }
  noArgs(rest.slice(1));
  return rest[0];
}

function noArgs(rest: string[]): void {
  if (rest.length > 0) {
    throw new CliError(`Unexpected argument: ${rest[0]}`, 2, true);
  }
}

// Validated up front so Postgres never raises a uuid cast error.
function parseId(value: string): string {
  if (!isUuid(value)) {
    throw new CliError(`Invalid id: ${value}`, 2);
  }
  return value;
}

// Names are validated on the way in, but rows written before that validation
// existed may still hold control characters; never print them raw.
function formatTable(headers: string[], rawRows: string[][]): string[] {
  const rows = rawRows.map((row) => row.map(stripControlChars));
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

async function orgList(db: Database, out: CliOutput): Promise<number> {
  const orgs = await listOrgs(db);
  if (orgs.length === 0) {
    out.stdout("No orgs.");
    return 0;
  }
  const rows = orgs.map((o) => [o.id, o.name, o.createdAt.toISOString(), String(o.memberCount), String(o.projectCount)]);
  formatTable(["ID", "NAME", "CREATED", "MEMBERS", "PROJECTS"], rows).forEach((line) => out.stdout(line));
  return 0;
}

async function projectCreate(db: Database, out: CliOutput, orgId: string, rawName: string): Promise<number> {
  const name = rawName.trim();
  if (!name) {
    throw new CliError("Project name is required", 2);
  }
  if (hasControlChars(name)) {
    throw new CliError("Project name must not contain control characters", 2);
  }
  if (!(await findOrg(db, orgId))) {
    throw new CliError(`Org not found: ${orgId}`, 1);
  }
  const { project, key } = await createProject(db, orgId, name);
  out.stdout(`Created project "${project.name}" (${project.id})`);
  out.stdout(key);
  out.stdout(KEY_WARNING);
  return 0;
}

async function projectList(db: Database, out: CliOutput): Promise<number> {
  const projects = await listProjects(db);
  if (projects.length === 0) {
    out.stdout("No projects.");
    return 0;
  }
  const rows = projects.map((p) => [p.id, p.orgId, p.name, p.createdAt.toISOString(), String(p.activeKeyCount)]);
  formatTable(["ID", "ORG", "NAME", "CREATED", "ACTIVE KEYS"], rows).forEach((line) => out.stdout(line));
  return 0;
}

async function keyCreate(db: Database, out: CliOutput, projectId: string): Promise<number> {
  const created = await createApiKey(db, projectId);
  if (!created) {
    throw new CliError(`Project not found: ${projectId}`, 1);
  }
  out.stdout(`Created API key for project ${projectId}`);
  out.stdout(created.key);
  out.stdout(KEY_WARNING);
  return 0;
}

async function keyList(db: Database, out: CliOutput, projectId: string): Promise<number> {
  const keys = await listApiKeys(db, projectId);
  if (keys.length === 0) {
    out.stdout("No API keys.");
    return 0;
  }
  const rows = keys.map((k) => [k.id, k.prefix, k.createdAt.toISOString(), k.revokedAt?.toISOString() ?? "-"]);
  formatTable(["ID", "PREFIX", "CREATED", "REVOKED"], rows).forEach((line) => out.stdout(line));
  return 0;
}

async function keyRevoke(db: Database, out: CliOutput, keyId: string): Promise<number> {
  const result = await revokeApiKey(db, keyId);
  if (!result) {
    throw new CliError(`Key not found: ${keyId}`, 1);
  }
  const { apiKey, alreadyRevoked } = result;
  if (alreadyRevoked) {
    out.stdout(`Key ${apiKey.prefix} already revoked at ${apiKey.revokedAt!.toISOString()}`);
  } else {
    out.stdout(`Revoked key ${apiKey.prefix} (${apiKey.id})`);
  }
  return 0;
}

async function userResetPassword(db: Database, out: CliOutput, email: string): Promise<number> {
  const user = await findUserByEmail(db, email);
  if (!user) {
    throw new CliError(`User not found: ${email}`, 1);
  }
  const password = generatePassword();
  await setPasswordHash(db, user.id, await hashPassword(password));
  await deleteUserSessions(db, user.id);
  out.stdout(`Reset password for ${user.email}`);
  out.stdout(password);
  out.stdout("Store this password now. It will not be shown again. The user was logged out everywhere.");
  return 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function orgRefs(orgs: OrgRef[]): string {
  return orgs.map((org) => `${stripControlChars(org.name)} (${org.id})`).join(", ");
}

async function userDelete(db: Database, out: CliOutput, email: string, confirmed: boolean): Promise<number> {
  const user = await findUserByEmail(db, email);
  if (!user) {
    throw new CliError(`User not found: ${email}`, 1);
  }
  const plan = await planUserDeletion(db, user.id);
  if (plan.blockingOrgs.length > 0) {
    throw new CliError(
      `${user.email} is the only owner of orgs with other members: ${orgRefs(plan.blockingOrgs)}. Make someone else an owner or delete those orgs first.`,
      1
    );
  }
  out.stdout(`User ${user.email} (${stripControlChars(user.name)})`);
  if (plan.soleMemberOrgs.length > 0) {
    const n = plan.soleMemberOrgs.length;
    out.stdout(`Also deletes ${plural(n, "org")} where they're the only member: ${orgRefs(plan.soleMemberOrgs)}`);
  }
  if (!confirmed) {
    throw new CliError(NOT_CONFIRMED, 2);
  }
  const result = await deleteUser(db, user.id);
  if (!result.ok) {
    // Someone joined or was promoted since the plan was read.
    throw new CliError(`${user.email} became the only owner of an org with other members: ${orgRefs(result.orgs)}`, 1);
  }
  out.stdout(`Deleted user ${user.email}`);
  return 0;
}

async function orgDelete(db: Database, out: CliOutput, orgId: string, confirmed: boolean): Promise<number> {
  const org = await findOrg(db, orgId);
  if (!org) {
    throw new CliError(`Org not found: ${orgId}`, 1);
  }
  const summary = await orgDeletionSummary(db, orgId);
  out.stdout(
    `Org ${stripControlChars(org.name)} (${org.id}): ${plural(summary.memberCount, "member")}, ${plural(summary.projectCount, "project")}, ${plural(summary.timelineCount, "timeline")}`
  );
  if (!confirmed) {
    throw new CliError(NOT_CONFIRMED, 2);
  }
  await deleteOrg(db, orgId);
  out.stdout(`Deleted org ${stripControlChars(org.name)}`);
  return 0;
}

async function inviteCreate(db: Database, out: CliOutput, deps: CliDeps, rawEmail: string | undefined): Promise<number> {
  const email = rawEmail === undefined ? undefined : normalizeEmail(rawEmail);
  if (email !== undefined && !EMAIL_PATTERN.test(email)) {
    throw new CliError(`Invalid email: ${rawEmail}`, 2);
  }
  if (email !== undefined && !deps.mailer) {
    throw new CliError("--email needs SMTP_URL and EMAIL_FROM to be set", 2);
  }
  const { id, expiresAt, token } = await createSignupInvite(db);
  const link = `${deps.publicUrl}/invite/${token}`;
  out.stdout(`Created signup invite ${id}, expires ${expiresAt.toISOString()}`);
  out.stdout(link);
  if (email === undefined || !deps.mailer) {
    out.stdout("Store this link now. It will not be shown again.");
    return 0;
  }
  try {
    await deps.mailer.send(signupInviteMail(email, link, expiresAt));
  } catch (error) {
    out.stderr(`Sending failed: ${error instanceof Error ? error.message : String(error)}`);
    out.stderr(`The link above still works. Send it yourself, or revoke it with: invite revoke ${id}`);
    return 1;
  }
  out.stdout(`Sent to ${email}`);
  return 0;
}

async function inviteList(db: Database, out: CliOutput): Promise<number> {
  const invites = await listPendingSignupInvites(db);
  if (invites.length === 0) {
    out.stdout("No pending signup invites.");
    return 0;
  }
  const rows = invites.map((i) => [i.id, i.createdAt.toISOString(), i.expiresAt.toISOString()]);
  formatTable(["ID", "CREATED", "EXPIRES"], rows).forEach((line) => out.stdout(line));
  return 0;
}

async function inviteRevoke(db: Database, out: CliOutput, inviteId: string): Promise<number> {
  if (!(await revokeSignupInvite(db, inviteId))) {
    throw new CliError(`Pending signup invite not found: ${inviteId}`, 1);
  }
  out.stdout(`Revoked signup invite ${inviteId}`);
  return 0;
}
