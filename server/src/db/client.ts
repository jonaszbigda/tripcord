import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;

/**
 * A database or an open transaction. Service functions that take an Executor can
 * run on their own or as one step of a caller's transaction.
 */
export type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;
