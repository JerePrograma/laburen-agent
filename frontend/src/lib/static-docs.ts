import type { DocSearchResult } from "@/lib/rag";

const STATIC_DOCS: Array<{
  path: string;
  keywords: string[];
  content: string;
}> = [
  {
    path: "manual/onboarding/resumen.md",
    keywords: ["onboarding", "inducción", "bienvenida", "documentación"],
    content:
      "Guía de onboarding comercial.\n" +
      "Duración: 10 días hábiles divididos en tres etapas (Descubrimiento, Practica Guiada y Operación Asistida).\n" +
      "Incluye checklist diario en Notion, videos cortos en Loom y playbooks descargables (PDF) para discovery, demo y cierre.\n" +
      "El kit de bienvenida está en Google Drive > Sales > Onboarding, con plantillas de emails, speech comercial y preguntas frecuentes.\n" +
      "Cada nuevo representante debe completar el assessment del día 5 y agendar retroalimentación con su buddy en el día 7.",
  },
  {
    path: "manual/integraciones/crm/crm-hubspot.md",
    keywords: ["crm", "hubspot", "integración", "pipeline", "sincronización"],
    content:
      "Integración del agente con HubSpot.\n" +
      "La autenticación usa una API key de servicio almacenada en Vault y se rota mensualmente.\n" +
      "Sincronización: los leads creados o actualizados por el agente se envían al endpoint /crm/v3/objects/contacts con el owner_id del usuario autenticado.\n" +
      "El agente consulta el pipeline 'Ventas LatAm' en modo lectura para traer etapas y follow-ups abiertos.\n" +
      "Los campos personalizados laburen_agent_status y laburen_agent_notes guardan el estado y comentarios generados por el asistente.",
  },
];

function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function fallbackDocSearch(question: string): DocSearchResult[] {
  const normalizedQuestion = normalize(question);
  const matches = STATIC_DOCS.filter((doc) =>
    doc.keywords.some((keyword) => normalizedQuestion.includes(normalize(keyword)))
  );

  return matches.map((doc, index) => ({
    id: 10_000 + index,
    path: doc.path,
    content: doc.content,
    similarity: Number((0.9 - index * 0.05).toFixed(3)),
  }));
}
