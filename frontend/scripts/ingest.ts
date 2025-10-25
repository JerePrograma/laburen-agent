// scripts/ingest.ts
import { readdir, readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
// opcional: solo si corrés local fuera de Docker
import dotenv from "dotenv";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carga local opcional. En Docker no hace falta: Compose ya inyecta envs.
dotenv.config(); 

const { createEmbedding } = await import("@/lib/embeddings");
const { query } = await import("@/lib/db");
const { chunkText, toPgVector } = await import("@/lib/utils");

async function collectFiles(root: string, relative = "."): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, path.join(relative, entry.name))));
    } else if (/\.(md|txt)$/i.test(entry.name)) {
      files.push(path.join(relative, entry.name));
    }
  }
  return files;
}

async function main() {
  const docsRoot = path.resolve(__dirname, "..", process.env.DOCS_ROOT ?? "../data");

  // Validaciones mínimas de entorno en runtime
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL ausente en runtime");
  if (!process.env.OLLAMA_BASE_URL) throw new Error("OLLAMA_BASE_URL ausente para embeddings");

  // Verifica dimensión real del modelo vs. schema
  const probe = await createEmbedding("probe");
  const actualDim = probe.length;
  const expectedDim = Number(process.env.EMBEDDING_DIM ?? "768");
  if (actualDim !== expectedDim) {
    throw new Error(
      `Dimensión inconsistente: esperado=${expectedDim} actual=${actualDim}. ` +
      `Ajustá EMBEDDING_DIM y vector(N) en init.sql.`
    );
  }

  const files = await collectFiles(docsRoot);
  if (files.length === 0) throw new Error(`Sin documentos en ${docsRoot}`);

  console.log(`Procesando ${files.length} documentos desde ${docsRoot}`);
  await query("TRUNCATE doc_chunk RESTART IDENTITY CASCADE", []);
  await query("TRUNCATE doc RESTART IDENTITY CASCADE", []);

  for (const relativePath of files) {
    const absolute = path.join(docsRoot, relativePath);
    const content = await readFile(absolute, "utf8");
    const chunks = chunkText(content);

    const docInsert = await query<{ id: number }>(
      `INSERT INTO doc(path, meta) VALUES ($1, $2::jsonb) RETURNING id`,
      [relativePath, JSON.stringify({ size: content.length })]
    );
    const docId = docInsert.rows[0].id;
    console.log(`→ ${relativePath} (${chunks.length} fragmentos)`);

    for (const chunk of chunks) {
      const emb = await createEmbedding(chunk);
      const vec = toPgVector(emb);
      await query(
        `INSERT INTO doc_chunk(doc_id, content, embedding)
         VALUES ($1, $2, $3::vector)`,
        [docId, chunk, vec]
      );
    }
  }
  console.log("✅ Ingesta completada");
  process.exit(0);
}

await main().catch((e) => {
  console.error("Error durante la ingesta:", e);
  process.exit(1);
});
