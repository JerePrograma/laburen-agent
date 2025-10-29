// ──────────────────────────────────────────────────────────────────────────────
// File: src/lib/db.ts — Pool de Postgres y helpers de consulta
// ──────────────────────────────────────────────────────────────────────────────

import { Pool, type QueryResult, type QueryResultRow } from "pg";

let _pool: Pool | null = null; // caché de Pool por proceso; evita crear conexiones redundantes

/**
 * ensurePool(): inicializa (perezoso) el Pool de Postgres a partir de DATABASE_URL.
 * - Lanza error si falta DATABASE_URL (solo cuando alguien consulta realmente).
 * - En serverless, confirmar que el proveedor soporta conexiones persistentes o usar pgBouncer.
 */
function ensurePool(): Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL ausente");
  _pool = new Pool({ connectionString: url });
  return _pool;
}

/**
 * query(text, params): wrapper tipado de pg.Pool#query.
 * - Ideal para SELECT/INSERT/UPDATE con SQL parametrizado.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return ensurePool().query<T>(text as string, params as any[]);
}

/**
 * queryOne(text, params): ejecuta una consulta y retorna la primera fila o null.
 * - Útil para lookups/UPSERTs que esperan 0..1 fila.
 */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const res = await query<T>(text, params);
  return res.rows[0] ?? null;
}
