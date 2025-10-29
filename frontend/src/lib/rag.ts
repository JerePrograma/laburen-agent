// ──────────────────────────────────────────────────────────────────────────────
// File: src/lib/search-documents.ts — Búsqueda semántica en Postgres/pgvector
// ──────────────────────────────────────────────────────────────────────────────

import { createEmbedding } from "@/lib/embeddings";
import { query } from "@/lib/db";
import { toPgVector } from "@/lib/utils";

type SearchRow = {
  id: number;
  path: string;
  content: string;
  similarity: number; // 1 - dist_cos
};

/**
 * searchDocuments(question, limit, minSimilarity):
 * - Crea embedding para la consulta.
 * - Calcula similitud como 1 - distancia coseno (<=>) y ordena por proximidad.
 * - Redondea similitud a 3 decimales y filtra por umbral mínimo.
 *
 * Notas de performance:
 * - Recomendado índice IVF/ivfflat o HNSW según tu extensión (pgvector >= 0.7
 *   soporta HNSW). Sin índice, será un scan secuencial costoso.
 */
export async function searchDocuments(
  question: string,
  limit = 3,
  minSimilarity = 0.25
) {
  const embedding = await createEmbedding(question);
  const vector = toPgVector(embedding);

  const sql = `
    SELECT dc.id::int AS id,
           d.path AS path,
           dc.content AS content,
           (1 - (dc.embedding <=> $1::vector))::float8 AS similarity
    FROM doc_chunk dc
    JOIN doc d ON dc.doc_id = d.id
    ORDER BY dc.embedding <=> $1::vector
    LIMIT $2
  `;
  const res = await query<SearchRow>(sql, [vector, limit]);
  return res.rows
    .map((r) => ({ ...r, similarity: Number(r.similarity.toFixed(3)) }))
    .filter((r) => r.similarity >= minSimilarity);
}
