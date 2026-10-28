import type pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

/**
 * Tests run against a REAL Postgres with pgvector: the compose `postgres` service.
 * Point HIVE_TEST_DATABASE_URL at a throwaway database; it is wiped on every reset.
 */
export const TEST_DB_URL =
  process.env.HIVE_TEST_DATABASE_URL ?? "postgres://hive:hive@127.0.0.1:5544/hive_test";

export async function freshDb(): Promise<pg.Pool> {
  const pool = createPool(TEST_DB_URL, 4); // same pool settings as the service
  await pool.query("drop schema public cascade; create schema public;");
  await migrate(pool);
  return pool;
}
