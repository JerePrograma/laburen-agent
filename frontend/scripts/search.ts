import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env"), quiet: true });

const { query } = await import("@/lib/db");
const { createEmbedding } = await import("@/lib/embeddings");
const { toPgVector } = await import("@/lib/utils");

type CliRow = { id: number; doc_id: number; snippet: string; similarity: number };

const q = process.argv.slice(2).join(" ") || "onboarding";
const emb = await createEmbedding(q);
const vec = toPgVector(emb);

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
const rows = res.rows.map((r) => ({ ...r, similarity: Number(r.similarity.toFixed(3)) }));
console.table(rows);
process.exit(0);
