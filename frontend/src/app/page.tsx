// src/app/page.tsx
"use client";

import { useCallback, useMemo } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { MessageCard } from "@/components/MessageCard";
import { AgentStatusPanel } from "@/components/AgentStatusPanel";
import { TraceTimeline } from "@/components/TraceTimeline";
import { useAgentConversation } from "@/hooks/useAgentConversation";
import type { ClientTimelineItem } from "@/lib/types";

/** Tipos estrechados robustos */
type ChatItem = Extract<ClientTimelineItem, { kind: "message" | "error" }>;
type TraceItem = Extract<ClientTimelineItem, { kind: "thought" | "tool" }>;

/** Type guards para que TS respete el filtro en useMemo */
function isChatItem(item: ClientTimelineItem): item is ChatItem {
  return item.kind === "message" || item.kind === "error";
}
function isTraceItem(item: ClientTimelineItem): item is TraceItem {
  return item.kind === "thought" || item.kind === "tool";
}

export default function HomePage() {
  const {
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
    submitCurrentMessage,
    sendMessage,
    resetConversation,
  } = useAgentConversation();

  /** Forzamos el tipo del arreglo resultante del filtro */
  const chatItems = useMemo<ChatItem[]>(
    () => timeline.filter(isChatItem),
    [timeline]
  );
  const traceItems = useMemo<TraceItem[]>(
    () => timeline.filter(isTraceItem),
    [timeline]
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await submitCurrentMessage();
    },
    [submitCurrentMessage]
  );

  const handleSuggestion = useCallback(
    async (prompt: string) => {
      if (!prompt || isStreaming || !conversationId) return;
      const sent = await sendMessage(prompt);
      if (sent) setInput("");
    },
    [conversationId, isStreaming, sendMessage, setInput]
  );

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.nativeEvent.isComposing
      ) {
        return;
      }
      event.preventDefault();
      if (isStreaming || !input.trim()) return;
      void submitCurrentMessage();
    },
    [input, isStreaming, submitCurrentMessage]
  );

  return (
    <main className="chat-page">
      <header className="header">
        <span className="small-label">
          Laburen.com Product Engineer Challenge
        </span>
        <h1>Agente conversacional con herramientas reales</h1>
        <p>
          Autenticación por chat, RAG con base local y ejecución de tools sobre
          Postgres. Observá en tiempo real cómo piensa el asistente, qué
          herramientas usa y cómo responde.
        </p>
      </header>

      <div className="chat-grid">
        <section className="chat-thread">
          <span className="small-label">Conversación</span>
          {chatItems.length === 0 ? (
            <div className="empty-state">
              Iniciá la conversación presentándote con tu nombre y código
              personal para que el agente pueda ayudarte.
            </div>
          ) : (
            chatItems.map((item) => {
              if (item.kind === "message") {
                return (
                  <MessageCard
                    key={item.id}
                    kind={item.role === "user" ? "user" : "assistant"}
                    title={item.role === "user" ? "Vos" : "Laburen Agent"}
                    streaming={item.streaming && isStreaming}
                  >
                    {item.content}
                  </MessageCard>
                );
              }
              // Aquí el tipo ya es { kind: "error"; id: string; text: string }
              return (
                <MessageCard key={item.id} kind="error" title="⚠️ Error">
                  {item.text}
                </MessageCard>
              );
            })
          )}
        </section>

        <aside className="sidebar">
          <AgentStatusPanel
            conversationId={conversationId}
            status={status}
            agentState={agentState}
            isStreaming={isStreaming}
            lastEventAt={lastEventAt}
            lastError={lastError}
            lastToolCall={lastToolCall}
            suggestions={suggestions}
            onSuggestion={handleSuggestion}
            onReset={resetConversation}
          />
          <TraceTimeline items={traceItems} />
        </aside>
      </div>

      <div className="composer">
        <form className="composer-form" onSubmit={handleSubmit}>
          <textarea
            placeholder="Escribí un mensaje..."
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            disabled={isStreaming}
            aria-label="Mensaje para el agente"
          />
          <button type="submit" disabled={isStreaming || !input.trim()}>
            {isStreaming ? "Esperá..." : "Enviar"}
          </button>
        </form>
      </div>
    </main>
  );
}