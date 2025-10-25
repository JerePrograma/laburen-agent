// src/lib/db.ts
import { Pool, type QueryResult, type QueryResultRow } from "pg";

let _pool: Pool | null = null;

function ensurePool(): Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL ausente"); // solo cuando alguien consulta realmente
  _pool = new Pool({ connectionString: url });
  return _pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return ensurePool().query<T>(text as string, params as any[]);
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const res = await query<T>(text, params);
  return res.rows[0] ?? null;
}
