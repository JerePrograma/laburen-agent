// src/lib/embeddings.ts
type OllamaEmbed = { embeddings: number[][] };
type OllamaLegacy = { embedding: number[] };

function hasEmbeddings(j: unknown): j is OllamaEmbed {
  return (
    !!j &&
    typeof j === "object" &&
    Array.isArray((j as any).embeddings) &&
    Array.isArray((j as any).embeddings[0]) &&
    typeof (j as any).embeddings[0][0] === "number"
  );
}

function hasLegacy(j: unknown): j is OllamaLegacy {
  return (
    !!j &&
    typeof j === "object" &&
    Array.isArray((j as any).embedding) &&
    typeof (j as any).embedding[0] === "number"
  );
}

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
