// ──────────────────────────────────────────────────────────────────────────────
// File: frontend/src/lib/client-utils.ts — Eventos SSE + utilidades de URL/IDs
// ──────────────────────────────────────────────────────────────────────────────

"use client"; // Next.js: fuerza ejecución en el cliente (CSR). Requerido para usar Web APIs como crypto.

/**
 * Base pública del backend para construir URLs. En dev puede ser vacío y usar paths relativos.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

export type ParsedAgentEvent = { name: string; data: unknown } | null;

/**
 * resolveApiUrl(path): concatena NEXT_PUBLIC_BACKEND_URL con el path dado.
 * - Recorta trailing slash del BASE para evitar '//' accidentales.
 * - Si no hay base, devuelve el path tal cual (útil en el mismo origen).
 */
export function resolveApiUrl(path: string) {
  if (!API_BASE_URL) return path;
  const base = API_BASE_URL.endsWith("/")
    ? API_BASE_URL.slice(0, API_BASE_URL.length - 1)
    : API_BASE_URL;
  return `${base}${path}`;
}

/**
 * createClientConversationId(): ID estable en el cliente para agrupar eventos.
 * - Usa crypto.randomUUID cuando existe; si no, un fallback pseudo-aleatorio.
 */
export function createClientConversationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

/**
 * parseAgentEvent(payload): parsea un bloque SSE (Server-Sent Events) a {name,data}.
 *
 * Formato SSE típico:
 *   event: <nombre>
 *   data: {json...}
 *   \n
 * - Junta múltiples líneas data: en un único payload.
 * - Ignora líneas vacías y comentarios que empiezan con ':'.
 * - Devuelve null si no hay 'data:' o si JSON.parse falla.
 */
export function parseAgentEvent(payload: string): ParsedAgentEvent {
  let name = "message"; // SSE usa 'message' por defecto si no hay 'event:'
  const dataLines: string[] = [];

  for (const rawLine of payload.split("\n")) {
    const line = rawLine.trimEnd(); // conserva espacios a la izquierda dentro de data
    if (!line) continue; // separador de eventos SSE
    if (line.startsWith(":")) continue; // comentarios SSE
    if (line.startsWith("event:")) {
      name = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return null;

  const dataPayload = dataLines.join("\n");
  try {
    return { name, data: JSON.parse(dataPayload) };
  } catch (error) {
    console.error(
      "No se pudo parsear el evento SSE del agente",
      error,
      payload
    );
    return null;
  }
}
