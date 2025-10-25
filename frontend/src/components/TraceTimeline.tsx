"use client";

import type { ClientTimelineItem } from "@/lib/types";

type TraceItem = Extract<ClientTimelineItem, { kind: "thought" | "tool" }>;

interface TraceTimelineProps {
  items: TraceItem[];
}

export function TraceTimeline({ items }: TraceTimelineProps) {
  if (items.length === 0) {
    return (
      <section className="trace-panel">
        <span className="small-label">Actividad del agente</span>
        <div className="trace-empty">
          Aún no hay pensamientos ni uso de herramientas. Iniciá la conversación
          con tu nombre y passcode para empezar.
        </div>
      </section>
    );
  }

  return (
    <section className="trace-panel">
      <span className="small-label">Actividad del agente</span>
      <div className="trace-list">
        {items.map((item) => {
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
                        {item.status === "success"
                          ? "Completado"
                          : item.status === "pending"
                          ? "En curso"
                          : "Error"}
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
    </section>
  );
}
