import { createEmbedding } from "@/lib/embeddings";
import { query } from "@/lib/db";
import { toPgVector } from "@/lib/utils";

export type DocSearchResult = {
  id: number;
  path: string;
  content: string;
  similarity: number; // 1 - dist_cos
};

export async function searchDocuments(
  question: string,
  limit = 3,
  minSimilarity = 0.25
): Promise<DocSearchResult[]> {
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
  const res = await query<DocSearchResult>(sql, [vector, limit]);
  return res.rows
    .map((r) => ({ ...r, similarity: Number(r.similarity.toFixed(3)) }))
    .filter((r) => r.similarity >= minSimilarity);
}
