"use client";

import { useMemo, useState } from "react";
import type { ClientTimelineItem, ClientToolCall } from "@/lib/types";

type TraceItem = Extract<ClientTimelineItem, { kind: "thought" | "tool" }>;
type ToolStatus = ClientToolCall["status"];

interface TraceTimelineProps {
  items: TraceItem[];
}

const DEFAULT_VISIBLE = 6;

function formatStatusLabel(status: ToolStatus) {
  switch (status) {
    case "success":
      return "Completado";
    case "pending":
      return "En curso";
    case "error":
      return "Error";
    default:
      return status;
  }
}

export function TraceTimeline({ items }: TraceTimelineProps) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = useMemo(() => {
    if (expanded || items.length <= DEFAULT_VISIBLE) return items;
    return items.slice(-DEFAULT_VISIBLE);
  }, [expanded, items]);
  const hiddenCount = Math.max(items.length - visibleItems.length, 0);

  if (items.length === 0) {
    return (
      <section className="trace-panel">
        <header className="trace-header">
          <span className="small-label">Actividad del agente</span>
        </header>
        <div className="trace-empty">
          Aún no hay pensamientos ni uso de herramientas. Iniciá la conversación
          con tu nombre y passcode para empezar.
        </div>
      </section>
    );
  }

  return (
    <section className="trace-panel">
      <header className="trace-header">
        <span className="small-label">Actividad del agente</span>
        <span className="muted">{items.length} evento{items.length === 1 ? "" : "s"}</span>
      </header>
      <div className="trace-list">
        {visibleItems.map((item) => {
          switch (item.kind) {
            case "thought":
              return (
                <div key={item.id} className="trace-card thought">
                  <div className="trace-title">💭 Pensamiento interno</div>
                  <p>{item.text}</p>
                </div>
              );
            case "tool":
              return (
                <details
                  key={item.id}
                  className={`trace-card tool ${item.status}`}
                  open={item.status === "error"}
                >
                  <summary>
                    <div className="trace-title">
                      🔧 {item.name}
                      <span className={`badge ${item.status}`}>
                        {formatStatusLabel(item.status)}
                      </span>
                    </div>
                  </summary>
                  <div className="trace-body">
                    <span className="muted">Input</span>
                    <pre>{JSON.stringify(item.input, null, 2)}</pre>
                    {item.result ? (
                      <>
                        <span className="muted">Resultado</span>
                        <pre>{JSON.stringify(item.result, null, 2)}</pre>
                      </>
                    ) : null}
                    {item.error ? (
                      <p className="trace-error">{item.error}</p>
                    ) : null}
                  </div>
                </details>
              );
            default:
              return null;
          }
        })}
      </div>
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="ghost-button compact"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "Ver menos"
            : `Mostrar ${hiddenCount} evento${hiddenCount === 1 ? "" : "s"} anteriores`}
        </button>
      ) : null}
    </section>
  );
}
