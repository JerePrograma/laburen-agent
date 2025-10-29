// ──────────────────────────────────────────────────────────────────────────────
// File: scripts/search-cli.ts — Búsqueda rápida en CLI contra pgvector
// ──────────────────────────────────────────────────────────────────────────────

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Carga .env desde la raíz del repo (dos niveles arriba de /scripts)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({
  path: path.resolve(__dirname, "..", "..", ".env"),
  quiet: true,
});

// Importes dinámicos para respetar alias ESM "@/"
const { query } = await import("@/lib/db");
const { createEmbedding } = await import("@/lib/embeddings");
const { toPgVector } = await import("@/lib/utils");

// Tipado de la fila de resultado en CLI (snippet corto + similitud)
type CliRow = {
  id: number;
  doc_id: number;
  snippet: string;
  similarity: number;
};

// Construcción de la consulta desde argv o valor por defecto
const q = process.argv.slice(2).join(" ") || "onboarding";
const emb = await createEmbedding(q);
const vec = toPgVector(emb);

// Consulta: top-5 por proximidad vectorial (distancia coseno). LEFT() genera snippet.
const sql = `
  SELECT dc.id::int AS id,
         dc.doc_id::int AS doc_id,
         LEFT(dc.content, 160) AS snippet,
         (1 - (dc.embedding <=> $1::vector))::float8 AS similarity
  FROM doc_chunk dc
  ORDER BY dc.embedding <=> $1::vector
  LIMIT 5
`;
const res = await query<CliRow>(sql, [vec]);
const rows = res.rows.map((r) => ({
  ...r,
  similarity: Number(r.similarity.toFixed(3)),
}));
console.table(rows); // salida tabular amigable en consola
process.exit(0);
