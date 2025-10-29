// ──────────────────────────────────────────────────────────────────────────────
// File: frontend/src/hooks/useAgentConversation.ts — Hook para chatear con el agente (SSE)
// ──────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createClientConversationId,
  parseAgentEvent,
  resolveApiUrl,
} from "@/lib/client-agent"; // Nota: asegurate de que el alias/resolución de rutas apunte a este módulo.
import type {
  AgentStateUpdate,
  ClientTimelineItem,
  ClientToolCall,
} from "@/lib/types";

// Estados posibles del ciclo de vida de la conversación
export type ConversationStatus =
  | "idle" // esperando acción del usuario
  | "connecting" // abriendo conexión con backend
  | "streaming" // recibiendo tokens/llamadas de tool por SSE
  | "error"; // se produjo un error en la conversación

// Decoder compartido para concatenar chunks binarios del stream SSE
const decoder = new TextDecoder();

/**
 * useAgentConversation(): orquesta el ciclo completo de conversación con el backend
 * vía SSE (Server-Sent Events), gestionando:
 * - conversationId (correlación en backend)
 * - timeline (mensajes, pensamientos y tool calls)
 * - estado del agente (p.ej., usuario autenticado)
 * - envío de mensajes y lectura del stream SSE (tokenes, eventos)
 * - control de abort/cancel para evitar fugas de memoria
 */
export function useAgentConversation() {
  // ─────────────────────────── Estado principal ───────────────────────────
  const [conversationId, setConversationId] = useState<string | null>(null); // correlación en backend
  const [timeline, setTimeline] = useState<ClientTimelineItem[]>([]); // línea de tiempo renderizable (mensajes, tools, errores)
  const [agentState, setAgentState] = useState<AgentStateUpdate>({}); // estado remoto (auth, etc.)
  const [input, setInput] = useState(""); // buffer de entrada del usuario (input controlado)
  const [isStreaming, setIsStreaming] = useState(false); // flag de envío/recepción en curso (para deshabilitar UI)
  const [status, setStatus] = useState<ConversationStatus>("idle"); // máquina de estados superficial
  const [lastError, setLastError] = useState<string | null>(null); // último error textual (para UI)
  const [lastEventAt, setLastEventAt] = useState<number | null>(null); // timestamp del último evento (para watchdogs)

  // Referencia al AbortController del stream actual; permite cancelar al desmontar o reiniciar
  const abortRef = useRef<AbortController | null>(null);

  // Al montar: genera conversationId si no existe y se asegura de abortar el stream al desmontar
  useEffect(() => {
    setConversationId((prev) => prev ?? createClientConversationId());
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ─────────────────────────── Helpers de timeline ───────────────────────────
  // updateTimeline: mutación atómica del estado timeline con patrón de función
  const updateTimeline = useCallback(
    (mutator: (current: ClientTimelineItem[]) => ClientTimelineItem[]) => {
      setTimeline((current) => mutator(current));
    },
    []
  );

  /**
   * upsertMessage: crea/actualiza un mensaje en timeline.
   * - Si no existe, lo inserta con contenido inicial.
   * - Si existe, concatena/actualiza contenido y flag de streaming.
   */
  const upsertMessage = useCallback(
    (
      id: string,
      role: "user" | "assistant",
      updater: (content: string) => string,
      options?: { streaming?: boolean }
    ) => {
      updateTimeline((current) => {
        const next = [...current];
        const index = next.findIndex(
          (item) => item.kind === "message" && item.id === id
        );
        if (index === -1) {
          next.push({
            kind: "message",
            id,
            role,
            content: updater(""),
            streaming: options?.streaming ?? role === "assistant",
          });
          return next;
        }
        const item = next[index];
        if (item.kind !== "message") return next; // protección por si hay colisión de IDs
        next[index] = {
          ...item,
          content: updater(item.content),
          streaming: options?.streaming ?? item.streaming,
        };
        return next;
      });
    },
    [updateTimeline]
  );

  /**
   * insertThought: registra/actualiza un "pensamiento" del agente (explicabilidad/UX).
   */
  const insertThought = useCallback(
    (id: string, text: string) => {
      updateTimeline((current) => {
        const next = [...current];
        const index = next.findIndex(
          (item) => item.kind === "thought" && item.id === id
        );
        if (index === -1) next.push({ kind: "thought", id, text });
        else next[index] = { kind: "thought", id, text };
        return next;
      });
    },
    [updateTimeline]
  );

  /**
   * registerToolCall: upsert de un evento de tool (pending → success/error con result).
   */
  const registerToolCall = useCallback(
    (call: ClientToolCall) => {
      updateTimeline((current) => {
        const next = [...current];
        const index = next.findIndex(
          (item) => item.kind === "tool" && item.id === call.id
        );
        if (index === -1) next.push({ kind: "tool", ...call });
        else next[index] = { kind: "tool", ...call };
        return next;
      });
    },
    [updateTimeline]
  );

  /**
   * pushError: agrega un ítem de error a la timeline (no bloquea otros elementos).
   */
  const pushError = useCallback(
    (text: string) => {
      updateTimeline((current) => [
        ...current,
        { kind: "error", id: createClientConversationId(), text },
      ]);
    },
    [updateTimeline]
  );

  // ───────────────────────── Manejo de eventos del agente ─────────────────────────
  /**
   * handleAgentEvent: despacha eventos SSE parseados hacia actualizaciones de estado/timeline.
   * Reconoce: thought, tool, tool_result, assistant_message, token, assistant_done, state, error.
   */
  const handleAgentEvent = useCallback(
    (event: NonNullable<ReturnType<typeof parseAgentEvent>>) => {
      const { name, data } = event;
      setLastEventAt(Date.now());
      switch (name) {
        case "thought": {
          const payload = data as { id: string; text: string };
          insertThought(payload.id, payload.text);
          break;
        }
        case "tool": {
          const payload = data as Pick<ClientToolCall, "id" | "name" | "input">;
          registerToolCall({ ...payload, status: "pending" });
          break;
        }
        case "tool_result": {
          const payload = data as ClientToolCall; // incluye result/status/error
          registerToolCall(payload);
          break;
        }
        case "assistant_message": {
          const payload = data as { id: string };
          upsertMessage(payload.id, "assistant", () => "", { streaming: true });
          break;
        }
        case "token": {
          const payload = data as { id: string; value: string };
          upsertMessage(
            payload.id,
            "assistant",
            (current) => current + payload.value
          );
          break;
        }
        case "assistant_done": {
          const payload = data as { id: string };
          upsertMessage(payload.id, "assistant", (current) => current, {
            streaming: false,
          });
          break;
        }
        case "state": {
          setAgentState(data as AgentStateUpdate); // e.g., authenticatedUser
          break;
        }
        case "error": {
          const payload = data as { message?: string };
          const message = payload?.message ?? "Error en el agente";
          setLastError(message);
          pushError(message);
          setStatus("error");
          break;
        }
        default:
          break; // eventos desconocidos se ignoran limpiamente
      }
    },
    [insertThought, pushError, registerToolCall, upsertMessage]
  );

  // ─────────────────────────────── Envío/stream SSE ───────────────────────────────
  /**
   * streamToAgent(message): envía el prompt al backend y consume el stream SSE.
   * - Aborta streams previos antes de iniciar uno nuevo.
   * - Separa eventos por doble salto de línea "\n\n" y usa parseAgentEvent para mapearlos.
   * - Actualiza status → connecting/streaming/idle y maneja abort/errors.
   */
  const streamToAgent = useCallback(
    async (message: string) => {
      if (!conversationId) {
        throw new Error("No hay conversación activa");
      }

      // Cancela stream previo si existe; registra el nuevo controller
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus("connecting");

      try {
        const response = await fetch(resolveApiUrl("/api/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, message }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorPayload = await response.text();
          throw new Error(
            errorPayload || `El backend respondió con estado ${response.status}`
          );
        }

        if (!response.body) {
          throw new Error("La respuesta del servidor no contiene stream");
        }

        const reader = response.body.getReader();
        let buffer = "";
        setStatus("streaming");

        // Bucle principal de lectura: concatena chunks y extrae eventos por "\n\n"
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");

          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");

            const parsed = parseAgentEvent(rawEvent);
            if (parsed) {
              handleAgentEvent(parsed);
            }
          }
        }

        // Cola final: procesa cualquier residuo no terminado con "\n\n"
        const tail = buffer.trim();
        if (tail) {
          const parsed = parseAgentEvent(tail);
          if (parsed) handleAgentEvent(parsed);
        }

        setStatus("idle");
      } catch (error) {
        if ((error as DOMException)?.name === "AbortError") {
          return; // cancelación esperada; no lo tratamos como error
        }
        setStatus("error");
        throw error; // deja que el caller setee UI/error state
      }
    },
    [conversationId, handleAgentEvent]
  );

  // ───────────────────────────── Entrypoint de envío ─────────────────────────────
  /**
   * sendMessage(rawMessage): agrega el mensaje del usuario al timeline y dispara el stream.
   * - Evita envíos vacíos o si ya hay un stream en curso.
   * - Maneja errores del transporte y los refleja en UI (timeline + lastError).
   */
  const sendMessage = useCallback(
    async (rawMessage: string) => {
      const trimmed = rawMessage.trim();
      if (!trimmed || isStreaming) return false;
      if (!conversationId) {
        pushError("Generando sesión, intentá nuevamente en un instante.");
        return false;
      }

      const messageId = createClientConversationId();
      updateTimeline((current) => [
        ...current,
        { kind: "message", id: messageId, role: "user", content: trimmed },
      ]);

      setLastError(null);
      setIsStreaming(true);

      try {
        await streamToAgent(trimmed);
        return true;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Error desconocido al conectar con el agente";
        pushError(message);
        setLastError(message);
        return false;
      } finally {
        setIsStreaming(false);
      }
    },
    [conversationId, isStreaming, pushError, streamToAgent, updateTimeline]
  );

  /**
   * submitCurrentMessage(): helper para enviar el contenido actual del input controlado.
   * - Limpia el input local si hay texto.
   */
  const submitCurrentMessage = useCallback(async () => {
    if (!input.trim()) return false;
    const pending = input;
    setInput("");
    return sendMessage(pending);
  }, [input, sendMessage]);

  /**
   * resetConversation(): reinicia por completo la sesión/estado en el cliente.
   * - Genera nuevo conversationId y limpia timeline/estado/errores.
   * - Aborta cualquier stream en curso para evitar fugas.
   */
  const resetConversation = useCallback(() => {
    abortRef.current?.abort();
    setTimeline([]);
    setAgentState({});
    setInput("");
    setLastError(null);
    setLastEventAt(null);
    setStatus("idle");
    setIsStreaming(false);
    setConversationId(createClientConversationId());
  }, []);

  // ───────────────────────────── Derivados (memo) ─────────────────────────────
  /**
   * lastToolCall: obtiene el último evento de tool para feedback contextual en UI.
   */
  const lastToolCall = useMemo(() => {
    const tools = timeline.filter(
      (item): item is Extract<ClientTimelineItem, { kind: "tool" }> =>
        item.kind === "tool"
    );
    return tools.length ? tools[tools.length - 1] : null;
  }, [timeline]);

  /**
   * suggestions: propone ejemplos de prompts, variando según estado de autenticación.
   */
  const suggestions = useMemo(() => {
    if (!agentState.authenticatedUser) {
      return [
        "Hola, soy Carla. Mi passcode es 123456.",
        "¿Qué documentación tienen sobre el onboarding?",
        "¿Cómo se integra el agente con el CRM actual?",
      ];
    }
    return [
      "Creá un lead para Ana Torres con email ana@ejemplo.com desde LinkedIn.",
      "Mostrame los últimos leads cargados.",
      "Registrá una nota con los próximos pasos de la demo.",
      "Mostrame las notas que tengo registradas.",
      "Agendá un follow-up para mañana a las 15 con la demo.",
      "Marcá como completado el follow-up 3.",
      "Buscá buenas prácticas comerciales en la documentación.",
    ];
  }, [agentState.authenticatedUser]);

  // ───────────────────────────── API del hook ─────────────────────────────
  return {
    conversationId,
    timeline,
    agentState,
    input,
    setInput,
    isStreaming,
    status,
    lastError,
    lastEventAt,
    lastToolCall,
    suggestions,
    sendMessage,
    submitCurrentMessage,
    resetConversation,
  } as const;
}
