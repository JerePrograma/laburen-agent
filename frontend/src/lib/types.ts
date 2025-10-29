// ──────────────────────────────────────────────────────────────────────────────
// File: src/lib/types.ts — Tipos compartidos para mensajes y timeline
// ──────────────────────────────────────────────────────────────────────────────

export type ConversationRole = "user" | "assistant";

/**
 * ClientMessage: unidad mostrable en la UI. `streaming` indica tokens en curso.
 */
export interface ClientMessage {
  id: string;
  role: ConversationRole;
  content: string;
  streaming?: boolean;
}

/**
 * AgentMessage: formato mínimo que persiste el backend en la session.
 */
export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * ClientThought: "pensamiento" del agente (transparencia para el usuario/UX).
 */
export interface ClientThought {
  id: string;
  text: string;
}

/**
 * ClientToolCall: evento de llamada a herramienta con resultado opcional.
 */
export interface ClientToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  status: "pending" | "success" | "error";
  error?: string;
}

/**
 * ClientTimelineItem: discriminado por `kind` para render en la UI (listado).
 */
export type ClientTimelineItem =
  | ({ kind: "message" } & ClientMessage)
  | ({ kind: "thought" } & ClientThought)
  | ({ kind: "tool" } & ClientToolCall)
  | { kind: "error"; id: string; text: string };

/**
 * AgentEventHandler: callbacks que consumen el stream SSE del backend.
 */
export interface AgentEventHandler {
  onThought(id: string, text: string): void;
  onToolCall(event: ClientToolCall): void;
  onToolResult(event: ClientToolCall): void;
  onAssistantMessage(id: string): void;
  onAssistantToken(id: string, value: string): void;
  onError(text: string): void;
  onState(state: AgentStateUpdate): void;
}

/**
 * AgentStateUpdate: actualiza estado global (p.ej., usuario autenticado en UI).
 */
export interface AgentStateUpdate {
  authenticatedUser?: {
    id: number;
    name: string;
  } | null;
}
