// ──────────────────────────────────────────────────────────────────────────────
// File: src/lib/embeddings.ts — Cliente de embeddings compatible con Ollama
// ──────────────────────────────────────────────────────────────────────────────

type OllamaEmbed = { embeddings: number[][] }; // formato nuevo: múltiples embeddings
type OllamaLegacy = { embedding: number[] }; // formato legacy: un solo embedding

/** Type guard: detecta respuesta { embeddings: number[][] } */
function hasEmbeddings(j: unknown): j is OllamaEmbed {
  return (
    !!j &&
    typeof j === "object" &&
    Array.isArray((j as any).embeddings) &&
    Array.isArray((j as any).embeddings[0]) &&
    typeof (j as any).embeddings[0][0] === "number"
  );
}

/** Type guard: detecta respuesta { embedding: number[] } */
function hasLegacy(j: unknown): j is OllamaLegacy {
  return (
    !!j &&
    typeof j === "object" &&
    Array.isArray((j as any).embedding) &&
    typeof (j as any).embedding[0] === "number"
  );
}

/**
 * fetchWithTimeout: wrapper de fetch con AbortController y timeout duro.
 * - Evita cuelgues si el servidor de embeddings no responde.
 * - Propaga un error con contexto de URL para logging.
 */
async function fetchWithTimeout(url: string, init: RequestInit, ms = 8_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw new Error(
      `Embeddings: fallo de red/timeout hacia ${url}: ${String(e)}`
    );
  } finally {
    clearTimeout(t);
  }
}

/**
 * createEmbedding(text): obtiene un embedding para 'text' con tres intentos
 * de compatibilidad:
 *  1) POST /api/embed con input: string
 *  2) POST /api/embed con input: [string]
 *  3) POST /api/embeddings (legacy) con prompt: string
 *
 * Lanza error si todas las variantes fallan o responden sin vector.
 */
export async function createEmbedding(text: string): Promise<number[]> {
  const url = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const model = process.env.EMBEDDING_MODEL || "nomic-embed-text";

  // 1) /api/embed con string
  let res = await fetchWithTimeout(`${url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });
  if (res.ok) {
    const j: unknown = await res.json().catch(() => ({}));
    if (hasEmbeddings(j)) return j.embeddings[0];
  }

  // 2) /api/embed con array
  res = await fetchWithTimeout(`${url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: [text] }),
  });
  if (res.ok) {
    const j: unknown = await res.json().catch(() => ({}));
    if (hasEmbeddings(j)) return j.embeddings[0];
  }

  // 3) /api/embeddings legacy
  res = await fetchWithTimeout(`${url}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (res.ok) {
    const j: unknown = await res.json().catch(() => ({}));
    if (hasLegacy(j)) return j.embedding;
  }

  const body = await res.text().catch(() => "");
  throw new Error(`Embeddings vacíos. Última resp: ${res.status} ${body}`);
}
