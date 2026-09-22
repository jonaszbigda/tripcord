import { parseArgs } from "node:util";
import type { Database } from "./db/client";
import { createApiKey, createProject, listApiKeys, listProjects, revokeApiKey } from "./db/projects";

export interface CliOutput {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const USAGE = `Usage: repro-admin <command>

Commands:
  project create <name>      Create a project and its first API key
  project list               List projects
  key create <projectId>     Create an additional API key for a project
  key list <projectId>       List a project's API keys
  key revoke <keyId>         Revoke an API key`;

const KEY_WARNING = "Store this API key now. It will not be shown again.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
export async function runCli(argv: string[], db: Database, out: CliOutput): Promise<number> {
  try {
    const [group, action, ...rest] = parsePositionals(argv);
    if (!group) {
      throw new CliError("Missing command", 2, true);
    }
    switch (`${group} ${action ?? ""}`) {
      case "project create":
        return await projectCreate(db, out, singleArg(rest, "<name>"));
      case "project list":
        noArgs(rest);
        return await projectList(db, out);
      case "key create":
        return await keyCreate(db, out, parseId(singleArg(rest, "<projectId>")));
      case "key list":
        return await keyList(db, out, parseId(singleArg(rest, "<projectId>")));
      case "key revoke":
        return await keyRevoke(db, out, parseId(singleArg(rest, "<keyId>")));
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

function parsePositionals(argv: string[]): string[] {
  try {
    // No options are defined, so strict mode rejects any flag (e.g. --json).
    return parseArgs({ args: argv, allowPositionals: true, strict: true }).positionals;
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
  if (!UUID_PATTERN.test(value)) {
    throw new CliError(`Invalid id: ${value}`, 2);
  }
  return value;
}

function formatTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

async function projectCreate(db: Database, out: CliOutput, rawName: string): Promise<number> {
  const name = rawName.trim();
  if (!name) {
    throw new CliError("Project name is required", 2);
  }
  const { project, key } = await createProject(db, name);
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
  const rows = projects.map((p) => [p.id, p.name, p.createdAt.toISOString(), String(p.activeKeyCount)]);
  formatTable(["ID", "NAME", "CREATED", "ACTIVE KEYS"], rows).forEach((line) => out.stdout(line));
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
