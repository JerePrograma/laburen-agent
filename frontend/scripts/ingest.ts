/**
 * scripts/ingest.ts — Ingestor de documentos para índice RAG con pgvector
 *
 * Propósito: leer archivos .md/.txt desde un directorio, fragmentarlos,
 * obtener embeddings y persistirlos en Postgres (tablas doc y doc_chunk).
 *
 * Flujo principal:
 *  1) Resolver ruta de documentos y validar variables de entorno claves.
 *  2) Verificar consistencia de la dimensión de embeddings con el schema DB.
 *  3) Limpiar tablas de destino (TRUNCATE) para una ingesta full.
 *  4) Recorrer archivos → fragmentar → embeddear → insertar en DB.
 *  5) Finalizar el proceso con código de salida adecuado.
 *
 * Supuestos previos:
 *  - Postgres tiene tablas: doc(id, path, meta) y doc_chunk(doc_id, content, embedding vector(N)).
 *  - EMBEDDING_DIM coincide con N del tipo vector(N) en la DB.
 *  - El proveedor de embeddings está disponible en OLLAMA_BASE_URL u otro backend compatible.
 *
 * Efectos secundarios relevantes:
 *  - TRUNCATE sobre doc y doc_chunk borra datos previos y reinicia IDs.
 *
 * Puntos de extensión:
 *  - Reemplazar TRUNCATE por upsert incremental.
 *  - Ejecutar inserts en batch y/o dentro de una transacción para mayor throughput.
 */

import { readdir, readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
// Carga local opcional de variables de entorno cuando se ejecuta fuera de Docker Compose.
import dotenv from "dotenv";

// __filename/__dirname en módulos ESM: se derivan a partir de import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// En Docker no suele ser necesario porque Compose inyecta envs.
dotenv.config();

// Importes dinámicos para resolver alias ("@/") y evitar pre-carga cuando no es necesario.
const { createEmbedding } = await import("@/lib/embeddings");
const { query } = await import("@/lib/db");
const { chunkText, toPgVector } = await import("@/lib/utils");

/**
 * Recorre recursivamente un directorio y devuelve paths relativos de archivos .md/.txt.
 *
 * @param root     Ruta absoluta raíz desde la cual se arma el recorrido.
 * @param relative Subruta relativa (se usa en la recursión). Por defecto ".".
 * @returns Lista de rutas relativas para persistir en la tabla doc.path.
 */
async function collectFiles(root: string, relative = "."): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Descenso recursivo a subdirectorios.
      files.push(
        ...(await collectFiles(root, path.join(relative, entry.name)))
      );
    } else if (/\.(md|txt)$/i.test(entry.name)) {
      // Filtro por extensiones de interés; se almacenan rutas relativas.
      files.push(path.join(relative, entry.name));
    }
  }
  return files;
}

/**
 * Punto de entrada del script.
 * Orquesta la validación de entorno, la limpieza, y la ingesta documento→chunks.
 */
async function main() {
  // 1) Resolver la raíz de documentos. Default ../data respecto a \"scripts/\".
  const docsRoot = path.resolve(
    __dirname,
    "..",
    process.env.DOCS_ROOT ?? "../data"
  );

  // 2) Validaciones mínimas de entorno en runtime.
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL ausente en runtime");
  if (!process.env.OLLAMA_BASE_URL)
    throw new Error("OLLAMA_BASE_URL ausente para embeddings");

  // 3) Verifica dimensión real del modelo de embeddings vs. lo esperado por el schema.
  //    Esto previene errores sutiles al castear hacia vector(N).
  const probe = await createEmbedding("probe");
  const actualDim = probe.length;
  const expectedDim = Number(process.env.EMBEDDING_DIM ?? "768");
  if (actualDim !== expectedDim) {
    throw new Error(
      `Dimensión inconsistente: esperado=${expectedDim} actual=${actualDim}. ` +
        `Ajustá EMBEDDING_DIM y vector(N) en init.sql.`
    );
  }

  // 4) Descubrir archivos a ingerir.
  const files = await collectFiles(docsRoot);
  if (files.length === 0) throw new Error(`Sin documentos en ${docsRoot}`);

  console.log(`Procesando ${files.length} documentos desde ${docsRoot}`);

  // 5) Limpieza full: ojo, esto borra y reinicia IDs. Útil para re-ingestas determinísticas.
  await query("TRUNCATE doc_chunk RESTART IDENTITY CASCADE", []);
  await query("TRUNCATE doc RESTART IDENTITY CASCADE", []);

  // 6) Ingesta documento por documento.
  for (const relativePath of files) {
    const absolute = path.join(docsRoot, relativePath);

    // Leer archivo completo en memoria. Para archivos muy grandes, considerar streaming + chunking.
    const content = await readFile(absolute, "utf8");

    // Fragmentación: delegada a utilitario para mantener consistencia de tamaño y solapamiento.
    const chunks = chunkText(content);

    // Registrar el documento padre con metadatos básicos (p.ej., tamaño en bytes/caracteres).
    const docInsert = await query<{ id: number }>(
      `INSERT INTO doc(path, meta) VALUES ($1, $2::jsonb) RETURNING id`,
      [relativePath, JSON.stringify({ size: content.length })]
    );
    const docId = docInsert.rows[0].id;

    console.log(`→ ${relativePath} (${chunks.length} fragmentos)`);

    // 6.1) Por cada chunk: embed → vector → insert.
    for (const chunk of chunks) {
      // Obtener el embedding del fragmento. Considerar throttling si el backend limita QPS.
      const emb = await createEmbedding(chunk);
      // Convertir a representación textual compatible con el tipo vector(N) de Postgres.
      const vec = toPgVector(emb);

      await query(
        `INSERT INTO doc_chunk(doc_id, content, embedding)
         VALUES ($1, $2, $3::vector)`,
        [docId, chunk, vec]
      );
    }
  }

  console.log("✅ Ingesta completada");
  // Cerrar el proceso explícitamente. En entornos controlados puede omitirse.
  process.exit(0);
}

// Manejo de errores a nivel toplevel para devolver código de salida != 0 en caso de falla.
await main().catch((e) => {
  console.error("Error durante la ingesta:", e);
  process.exit(1);
});
