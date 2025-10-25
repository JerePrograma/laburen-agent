"use client";

const API_BASE_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

export type ParsedAgentEvent = { name: string; data: unknown } | null;

export function resolveApiUrl(path: string) {
  if (!API_BASE_URL) return path;
  const base = API_BASE_URL.endsWith("/")
    ? API_BASE_URL.slice(0, API_BASE_URL.length - 1)
    : API_BASE_URL;
  return `${base}${path}`;
}

export function createClientConversationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export function parseAgentEvent(payload: string): ParsedAgentEvent {
  let name = "message";
  const dataLines: string[] = [];

  for (const rawLine of payload.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
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
    console.error("No se pudo parsear el evento SSE del agente", error, payload);
    return null;
  }
}
