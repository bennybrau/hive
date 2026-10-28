import pg from "pg";

export type Pool = pg.Pool;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** Map pg / socket errors to an action the operator can take. */
export function describeDbError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const hints: Record<string, string> = {
    "28P01": "wrong Postgres password - POSTGRES_PASSWORD in .env must match the one the volume was created with",
    "3D000": "database does not exist - check the database name in DATABASE_URL",
    ECONNREFUSED: "nothing listening at DATABASE_URL - is the postgres container up? (docker compose ps)",
    ENOTFOUND: "DATABASE_URL host does not resolve",
  };
  const hint = e.code ? hints[e.code] : undefined;
  return hint ? `${e.message} (${hint})` : String(e.message ?? err);
}

export async function pingDb(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
