"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createClientConversationId,
  parseAgentEvent,
  resolveApiUrl,
} from "@/lib/client-agent";
import type {
  AgentStateUpdate,
  ClientTimelineItem,
  ClientToolCall,
} from "@/lib/types";

export type ConversationStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "error";

const decoder = new TextDecoder();

export function useAgentConversation() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<ClientTimelineItem[]>([]);
  const [agentState, setAgentState] = useState<AgentStateUpdate>({});
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<ConversationStatus>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setConversationId((prev) => prev ?? createClientConversationId());
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const updateTimeline = useCallback(
    (mutator: (current: ClientTimelineItem[]) => ClientTimelineItem[]) => {
      setTimeline((current) => mutator(current));
    },
    []
  );

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
        if (item.kind !== "message") return next;
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

  const pushError = useCallback(
    (text: string) => {
      updateTimeline((current) => [
        ...current,
        { kind: "error", id: createClientConversationId(), text },
      ]);
    },
    [updateTimeline]
  );

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
          const payload = data as ClientToolCall;
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
          upsertMessage(payload.id, "assistant", (current) => current + payload.value);
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
          setAgentState(data as AgentStateUpdate);
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
          break;
      }
    },
    [insertThought, pushError, registerToolCall, upsertMessage]
  );

  const streamToAgent = useCallback(
    async (message: string) => {
      if (!conversationId) {
        throw new Error("No hay conversación activa");
      }

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

        // limpiar cualquier resto del buffer
        const tail = buffer.trim();
        if (tail) {
          const parsed = parseAgentEvent(tail);
          if (parsed) handleAgentEvent(parsed);
        }

        setStatus("idle");
      } catch (error) {
        if ((error as DOMException)?.name === "AbortError") {
          return;
        }
        setStatus("error");
        throw error;
      }
    },
    [conversationId, handleAgentEvent]
  );

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

  const submitCurrentMessage = useCallback(async () => {
    if (!input.trim()) return false;
    const pending = input;
    setInput("");
    return sendMessage(pending);
  }, [input, sendMessage]);

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

  const lastToolCall = useMemo(() => {
    const tools = timeline.filter(
      (item): item is Extract<ClientTimelineItem, { kind: "tool" }> =>
        item.kind === "tool"
    );
    return tools.length ? tools[tools.length - 1] : null;
  }, [timeline]);

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