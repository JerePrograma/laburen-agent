"use client";

import { useMemo } from "react";
import type { ConversationStatus } from "@/hooks/useAgentConversation";
import type { AgentStateUpdate, ClientToolCall } from "@/lib/types";

interface AgentStatusPanelProps {
  conversationId: string | null;
  status: ConversationStatus;
  agentState: AgentStateUpdate;
  isStreaming: boolean;
  lastEventAt: number | null;
  lastError: string | null;
  lastToolCall: ClientToolCall | null;
  suggestions: string[];
  onSuggestion: (prompt: string) => void;
  onReset: () => void;
}

const KEYWORD_GUIDE: Array<{
  category: string;
  description: string;
  keywords: string[];
  example: string;
}> = [
  {
    category: "Leads",
    description: "Para dar de alta contactos y seguir oportunidades.",
    keywords: ["creá", "crear", "registrá", "cargá"],
    example: "Creá un lead para Ana Torres con email ana@ejemplo.com desde LinkedIn.",
  },
  {
    category: "Notas",
    description: "Para documentar próximos pasos o hallazgos de reuniones.",
    keywords: ["registrá", "guardá", "anotá"],
    example: "Registrá una nota con los próximos pasos de la demo.",
  },
  {
    category: "Documentación",
    description: "Para buscar guías y mejores prácticas en la base de conocimiento.",
    keywords: ["buscá", "consultá", "mostrame"],
    example: "Buscá buenas prácticas comerciales en la documentación.",
  },
];

function KeywordGuide() {
  return (
    <div className="keyword-guide">
      <span className="small-label">Guía de palabras clave</span>
      <div className="keyword-guide-grid">
        {KEYWORD_GUIDE.map((entry) => (
          <article key={entry.category} className="keyword-card">
            <header className="keyword-card-header">
              <h3>{entry.category}</h3>
              <p>{entry.description}</p>
            </header>
            <div className="keyword-chip-row">
              {entry.keywords.map((keyword) => (
                <span key={keyword} className="keyword-chip">
                  {keyword}
                </span>
              ))}
            </div>
            <p className="keyword-example">Ejemplo: “{entry.example}”</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function formatStatus(status: ConversationStatus, isStreaming: boolean) {
  if (status === "streaming" && isStreaming) return "Respondiendo";
  if (status === "connecting") return "Conectando";
  if (status === "error") return "Error";
  return "Listo";
}

function formatLastEvent(lastEventAt: number | null) {
  if (!lastEventAt) return "Sin actividad";
  const diff = Date.now() - lastEventAt;
  const seconds = Math.round(diff / 1000);
  if (seconds < 5) return "Justo ahora";
  if (seconds < 60) return `Hace ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `Hace ${hours} h`;
}

function formatLeadSummary(call: ClientToolCall) {
  const result = (call.result as any) ?? {};
  const lead = result?.lead ?? result;
  const input = (call.input as any) ?? {};
  const name = lead?.name ?? input?.name;
  const email = lead?.email ?? input?.email;
  const source = lead?.source ?? input?.source;
  const leadId = lead?.id ?? result?.leadId;
  const createdAt = lead?.createdAt ?? result?.createdAt;
  const parts = [
    name ? String(name) : null,
    email ? `<${String(email)}>` : null,
  ].filter(Boolean);
  if (source) parts.push(`Fuente: ${String(source)}`);
  const meta: string[] = [];
  if (leadId) meta.push(`ID ${leadId}`);
  if (createdAt) {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.valueOf())) {
      meta.push(parsed.toLocaleString());
    }
  }
  return [parts.join(" · ") || "Lead creado", meta.join(" • ")]
    .filter(Boolean)
    .join("\n");
}

function formatNoteSummary(call: ClientToolCall) {
  const result = (call.result as any) ?? {};
  const text = result?.text ?? (call.input as any)?.text;
  const noteId = result?.noteId;
  const createdAt = result?.createdAt;
  const lines: string[] = [];
  if (text && typeof text === "string") {
    const trimmed = text.trim();
    if (trimmed) {
      lines.push(
        `Nota: "${
          trimmed.length > 140 ? `${trimmed.slice(0, 137).trimEnd()}…` : trimmed
        }"`
      );
    }
  }
  const meta: string[] = [];
  if (noteId) meta.push(`ID ${noteId}`);
  if (createdAt) {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.valueOf())) meta.push(parsed.toLocaleString());
  }
  if (meta.length) lines.push(meta.join(" • "));
  return lines.join("\n") || "Nota guardada";
}

function formatSearchSummary(call: ClientToolCall) {
  const result = (call.result as any) ?? {};
  const matches = Array.isArray(result?.results) ? result.results : [];
  const count = matches.length;
  const header = `${count} resultado${count === 1 ? "" : "s"}`;
  const extras: string[] = [];
  if (result?.question) extras.push(`Consulta: "${String(result.question)}"`);
  if (matches[0]?.path) extras.push(`Ejemplo: ${matches[0].path}`);
  return [header, extras.join(" • ")].filter(Boolean).join("\n");
}

function formatAuthSummary(call: ClientToolCall) {
  const result = (call.result as any) ?? {};
  const user = result?.user ?? {};
  const input = (call.input as any) ?? {};
  const name = user?.name ?? input?.name;
  const id = user?.id;
  const lines = [name ? String(name) : "Autenticación"];
  if (id) lines.push(`ID ${id}`);
  return lines.join("\n");
}

function formatToolSummary(call: ClientToolCall) {
  if (call.status === "error") return call.error ?? "Falló";
  switch (call.name) {
    case "verify_passcode":
      return formatAuthSummary(call);
    case "create_lead":
      return formatLeadSummary(call);
    case "record_note":
      return formatNoteSummary(call);
    case "search_docs":
      return formatSearchSummary(call);
    default:
      return call.name;
  }
}

function formatToolTitle(call: ClientToolCall) {
  if (call.status === "error") return `${call.name} (error)`;
  switch (call.name) {
    case "verify_passcode":
      return "Autenticación";
    case "create_lead":
      return "Lead creado";
    case "record_note":
      return "Nota guardada";
    case "search_docs":
      return "Búsqueda de documentos";
    default:
      return call.name;
  }
}

function ToolCallPreview({ call }: { call: ClientToolCall }) {
  const badgeClass = `badge ${call.status}`;
  const summary = useMemo(() => formatToolSummary(call), [call]);
  const title = useMemo(() => formatToolTitle(call), [call]);

  return (
    <div className="status-block">
      <div className="status-block-header">
        <span className="badge tool">Tool</span>
        <span className={badgeClass}>{call.status === "success" ? "OK" : "Error"}</span>
      </div>
      <div className="status-block-title">{title}</div>
      <p className="status-block-body">{summary}</p>
      {call.error ? <p className="status-block-error">{call.error}</p> : null}
    </div>
  );
}

export function AgentStatusPanel({
  conversationId,
  status,
  agentState,
  isStreaming,
  lastEventAt,
  lastError,
  lastToolCall,
  suggestions,
  onSuggestion,
  onReset,
}: AgentStatusPanelProps) {
  const statusLabel = formatStatus(status, isStreaming);
  const lastActivity = formatLastEvent(lastEventAt);
  const userName = agentState.authenticatedUser?.name ?? "No verificado";

  return (
    <section className="status-panel">
      <header className="status-header">
        <div>
          <span className="small-label">Sesión activa</span>
          <h2>{conversationId ?? "Generando..."}</h2>
        </div>
        <button type="button" className="ghost-button" onClick={onReset}>
          Reiniciar
        </button>
      </header>

      <div className="status-grid">
        <div className="status-card">
          <span className="badge neutral">Estado</span>
          <strong>{statusLabel}</strong>
          <span className="muted">Última actividad: {lastActivity}</span>
        </div>
        <div className="status-card">
          <span className="badge neutral">Usuario</span>
          <strong>{userName}</strong>
          <span className="muted">
            {agentState.authenticatedUser
              ? `ID ${agentState.authenticatedUser.id}`
              : "Necesita passcode"}
          </span>
        </div>
      </div>

      {lastToolCall ? <ToolCallPreview call={lastToolCall} /> : null}

      {lastError ? (
        <div className="status-error">⚠️ {lastError}</div>
      ) : null}

      <div className="quick-actions">
        <span className="small-label">Ideas para probar</span>
        <div className="quick-actions-grid">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="pill-button"
              onClick={() => onSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>

      <KeywordGuide />
    </section>
  );
}
