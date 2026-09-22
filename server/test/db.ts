import { inject } from "vitest";
import { createDb, type Database } from "../src/db/client";

export function getTestDb(): Database {
  return createDb(inject("databaseUrl"));
}
