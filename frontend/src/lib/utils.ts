// ──────────────────────────────────────────────────────────────────────────────
// File: src/lib/utils.ts — utilidades varias (pgvector, chunking, delay)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * toPgVector(values): serializa un array de números al literal textual de pgvector.
 * - Formato esperado: "[v1,v2,...]". No valida longitud.
 */
export function toPgVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

/**
 * chunkText(text, size, overlap): fragmenta texto por párrafos con solapamiento.
 * - Primero normaliza CRLF → LF y separa por 2+ saltos de línea (párrafos).
 * - Si un párrafo es más largo que `size`, lo corta en ventanas con `overlap`.
 * - Devuelve fragmentos sin líneas vacías.
 */
export function chunkText(text: string, size = 700, overlap = 120): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= size) {
      chunks.push(paragraph.trim());
      continue;
    }
    let start = 0;
    while (start < paragraph.length) {
      const end = Math.min(start + size, paragraph.length);
      const slice = paragraph.slice(start, end).trim();
      if (slice) {
        chunks.push(slice);
      }
      if (end === paragraph.length) break;
      start = end - overlap; // retrocede para mantener contexto entre chunks
    }
  }
  return chunks.filter(Boolean);
}

/**
 * delay(ms): promesa que resuelve luego de `ms` milisegundos.
 * - Útil para simular latencia de streaming o backoff simple.
 */
export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
