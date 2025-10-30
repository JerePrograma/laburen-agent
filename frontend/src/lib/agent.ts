/**
 * src/lib/agent.ts — Orquestador del "Laburen Agent"
 *
 * Objetivo: interpretar mensajes del usuario, ejecutar herramientas (tools)
 * cuando aplique y producir respuestas en streaming. El agente optimiza
 * latencia con rutas rápidas (fast-path) por regex para intents frecuentes
 * y, sólo si no alcanza, delega a un LLM con un contrato JSON fuerte.
 *
 * Puntos clave del diseño:
 * - Estado de conversación: historial + usuario autenticado en session-store.
 * - Emisor de eventos (AgentEventEmitter) para UI: pensamiento, tokens,
 *   llamadas a tools y resultados.
 * - Planificación con JSON estricto (zod). Fallback robusto cuando el LLM
 *   incumple el contrato.
 * - Fast-path: intents comunes detectados con regex en español, evitando
 *   round-trips al LLM.
 * - LLM loop con reintento de parseo (jsonrepair) y "retry prompt".
 *
 * Seguridad/consistencia:
 * - Validación de inputs por herramienta con zod (def.schema.parse).
 * - Normalización de fechas para mensajes humanos.
 * - Límite de iteraciones para evitar bucles.
 */

import { randomUUID } from "crypto";
import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import { delay } from "@/lib/utils";
import { getSession, saveSession } from "@/lib/session-store";
import { tools } from "@/lib/tools";
// ToolName: unión de las claves disponibles en el registro de tools.
type ToolName = keyof typeof tools;
import type { AgentMessage } from "@/lib/types";
import { openrouterChat } from "@/lib/openrouter";

// ----------------------------- Tipos de plan ------------------------------
// Plan es la "orden" que el LLM devuelve: ejecutar tool o responder texto.
type Plan = z.infer<typeof PlanSchema>;
type RespondPlan = Extract<Plan, { action: "respond" }>;

// --------------------------- Canalización de eventos -----------------------
// Los eventos modelan el ciclo de vida para la UI: pensamiento, ejecución,
// streaming de tokens, estado de auth y errores.
export type AgentEvent =
  | { event: "thought"; data: { id: string; text: string } }
  | { event: "tool"; data: { id: string; name: string; input: unknown } }
  | {
      event: "tool_result";
      data: {
        id: string;
        name: string;
        input: unknown;
        result: unknown;
        status: "success" | "error";
        error?: string;
      };
    }
  | { event: "assistant_message"; data: { id: string } }
  | { event: "assistant_done"; data: { id: string } }
  | { event: "token"; data: { id: string; value: string } }
  | {
      event: "state";
      data: { authenticatedUser?: { id: number; name: string } | null };
    }
  | { event: "error"; data: { message: string } };

export type AgentEventEmitter = (event: AgentEvent) => void;

// Lista de nombres de tools válidos para el discriminante del schema.
const TOOL_NAMES = Object.keys(tools) as [string, ...string[]];

// ------------------------- Contrato de salida del LLM ----------------------
// PlanSchema fuerza un JSON con action = "tool" | "respond" y campos útiles.
const PlanSchema = z.discriminatedUnion("action", [
  z.object({
    thought: z.string().default(""),
    action: z.literal("tool"),
    tool: z.object({
      name: z.enum(TOOL_NAMES), // restringe a tools registradas
      input: z.unknown().optional(), // el parseo fino lo hace cada tool
    }),
    final_response: z.null().optional(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
  }),
  z.object({
    thought: z.string().default(""),
    action: z.literal("respond"),
    final_response: z.string().min(1), // respuesta final humana
    tool: z.null().optional(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
  }),
]);

// Prompt base con reglas de negocio y catálogo de tools.
const BASE_PROMPT = `Eres Laburen Agent, un agente de producto que ayuda a equipos comerciales.
Devuelve SOLO un JSON válido, sin texto extra, con: thought, action, tool, final_response.
1) No respondas al usuario hasta autenticar con verify_passcode.
2) Antes de leads/notas, confirma autenticación.
3) Usa search_docs para contexto de /data cuando haga falta.
4) Si dudas del formato, reintenta devolviendo SOLO JSON válido.
5) Español neutro, profesional y claro.

Tools (usa siempre JSON en tool.input):
- verify_passcode { "name": string, "passcode": string }
- create_lead { "name": string, "email": string, "source"?: string }
- record_note { "text": string }
- list_notes { "limit"?: number }
- delete_note { "noteId": number }
- list_leads { "limit"?: number }
- schedule_followup { "title": string, "dueAt"?: string, "notes"?: string }
- list_followups { "status"?: "pending"|"completed", "limit"?: number }
- complete_followup { "followUpId": number }
- search_docs { "question": string }

Ejemplo válido:
{"thought":"Voy a verificar passcode","action":"tool","tool":{"name":"verify_passcode","input":{"name":"Carla","passcode":"123456"}},"final_response":null}`;

// ------------------------------ Utilidades LLM -----------------------------
// Mapeo de historial conversacional a formato del proveedor OpenRouter.
type ORMessage = { role: "user" | "assistant"; content: string };
const buildMessages = (history: AgentMessage[]): ORMessage[] =>
  history.map((m) => ({ role: m.role, content: m.content }));

// Particiona texto en trozos pequeños para streaming; evita buffers grandes.
function chunkResponse(text: string) {
  const words = text.split(/(\s+)/).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  for (const w of words) {
    buf += w;
    if (buf.length >= 18) {
      // umbral simple, configurable
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [text];
}

// -------------------------- Parseo robusto de Plan -------------------------
// Intenta parsear JSON exacto. Si falla, recorta al bloque {...} más amplio.
// Luego aplica jsonrepair como último recurso.
function parsePlan(raw: string): Plan | null {
  const tryParse = (s: string): Plan | null => {
    try {
      return PlanSchema.parse(JSON.parse(s));
    } catch {
      return null;
    }
  };
  let p = tryParse(raw);
  if (p) return p;
  const a = raw.indexOf("{"),
    b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) {
    p = tryParse(raw.slice(a, b + 1));
    if (p) return p;
  }
  try {
    return tryParse(jsonrepair(raw));
  } catch {
    return null;
  }
}

// ---------------------------- Fallback determinista ------------------------
// Construye un plan de respuesta segura cuando el LLM incumple el contrato
// o no hay autenticación. No ejecuta tools.
function fallbackPlan(reason: string, authenticated: boolean): RespondPlan {
  return {
    thought: `Fallback: ${reason}`,
    action: "respond",
    final_response: authenticated
      ? "Hubo un problema al interpretar la respuesta del asistente. Podés intentar de nuevo."
      : "Acceso por invitación con passcode. ¿Querés registrar un lead, una nota o buscar en la documentación?",
    tool: null,
    confidence: "low",
  };
}

// Emite un mensaje de asistente con tokens en streaming. Simula latencia.
async function emitStreamingText(emit: AgentEventEmitter, text: string) {
  const id = randomUUID();
  emit({ event: "assistant_message", data: { id } });
  for (const chunk of chunkResponse(text)) {
    emit({ event: "token", data: { id, value: chunk } });
    await delay(30); // delay corto para UX
  }
  emit({ event: "assistant_done", data: { id } });
  return id;
}

// ------------------------------ FAST-PATHS ---------------------------------
// Heurísticas con regex en español para reducir latencia y costo.

// Normaliza extremos y espacios; deja caracteres relevantes para intent.
const stripPunct = (s: string) =>
  s
    .replace(/^[^A-Za-zÁÉÍÓÚÑáéíóúñ]+|[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9'() :.,-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

// -------------------------- Intent: verify_passcode ------------------------
// Extrae nombre y passcode de frases del tipo "Soy Ana, mi passcode es 123".
function extractPasscodeIntent(
  text: string
): { name: string; passcode: string } | null {
  const nameRe =
    /\b(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ' -]{1,60}?)(?=[,.;:!?)]|\s|$)/i;
  const passRe =
    /\b(?:passcode|c(?:ó|o)digo|clave)\s*(?:es|:)?\s*([A-Za-z0-9-]{3,64})\b/i;
  const nameMatch = nameRe.exec(text);
  const passMatch = passRe.exec(text);
  if (!nameMatch || !passMatch) return null;
  const name = stripPunct(nameMatch[1]);
  const passcode = passMatch[1].trim();
  if (!name || !passcode) return null;
  return { name, passcode };
}

// ---------------------------- Intent: record_note --------------------------
// Detecta órdenes de registrar/guardar/anotar una nota y extrae el texto.
function extractRecordNote(msg: string) {
  // “Registrá/Guardá/Anotá … nota … <texto>” o “nota: …”
  const re1 =
    /(?:registr(?:a|á|ar)|guard(?:a|á|ar)|anot(?:a|á|ar)).*?\bnota\b[:\s,.-]*([\s\S]+)$/i;
  const re2 = /\bnota\b\s*[:\-]\s*([\s\S]+)$/i;
  const m = re1.exec(msg) ?? re2.exec(msg);
  const text = (m?.[1] ?? "").toString();
  const cleaned = stripPunct(text);
  return cleaned.length >= 3 ? { text: cleaned } : null;
}

// ---------------------------- Intent: create_lead --------------------------
// Extrae nombre, email y fuente opcional de frases naturales.
const emailRe = /<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i;
function extractCreateLead(text: string) {
  // “Creá un lead para Ana ... con email/correo/mail x@x.com desde <fuente>”
  const m = text.match(
    /lead\s+para\s+(.+?)\s+con\s+(?:correo|email|mail)\s+(.+?)(?:\s+(?:desde|de)\s+(.+?))?[.?!]*$/i
  );
  if (m) {
    const name = stripPunct(m[1]);
    const email = (m[2].match(emailRe)?.[1] ?? m[2]).trim();
    const source = stripPunct(m[3] ?? "");
    if (name && emailRe.test(email))
      return { name, email, ...(source ? { source } : {}) };
  }
  // fallback: "<nombre> <email> [desde <source>]"
  const e = text.match(emailRe)?.[1];
  if (!e) return null;
  const before = text
    .slice(0, text.indexOf(e))
    .replace(/.*para\s+/i, "")
    .trim();
  const src = text
    .slice(text.indexOf(e) + e.length)
    .match(/(?:desde|de)\s+(.+?)$/i)?.[1]
    ?.trim();
  const name = stripPunct(before);
  return name && emailRe.test(e)
    ? { name, email: e, ...(src ? { source: stripPunct(src) } : {}) }
    : null;
}

// ----------------------- Intent: complete_followup -------------------------
// Ej.: “Completá el follow-up 3” o “Follow-up #5 completado”.
function extractCompleteFollowUp(text: string) {
  const m =
    /(?:marc(a|á)|complet(a|á)|cerr(a|á)).*?follow[- ]?up\s*#?\s*(?<id>\d+)\b/i.exec(
      text
    ) ||
    /follow[- ]?up\s*#?\s*(?<id>\d+)\b.*?(?:complet(a|á)|cerr(a|á))/i.exec(
      text
    );
  const id = m?.groups?.id ? Number(m.groups.id) : NaN;
  return Number.isFinite(id) ? { followUpId: id } : null;
}

// -------------------------- Intent: search_docs ----------------------------
// Detecta preguntas o búsquedas explícitas sobre documentación.
function extractSearchDocs(text: string) {
  const t = text.toLowerCase();

  const hasQuestionPunct = /[¿?]/.test(t);
  const hasInterrogatives = /\b(cómo|qué|dónde|cuándo|por qué|para qué)\b/.test(
    t
  );

  const hasDocsWords =
    /\b(documentación|documentos|manual|guía|onboarding|prácticas)\b/.test(t);
  const explicitSearch = /^\s*busc(a|á|ar)\b/.test(t);
  const hasKnowledgeKeywords =
    /\b(embedding|embeddings|vector|rag|modelo|stack|arquitectura|pipeline|contexto)\b/.test(
      t
    );

  if (
    (hasQuestionPunct || hasInterrogatives) &&
    (hasDocsWords || explicitSearch || hasKnowledgeKeywords)
  ) {
    return { question: stripPunct(text) };
  }
  if (explicitSearch && (hasDocsWords || hasKnowledgeKeywords))
    return { question: stripPunct(text) };
  return null;
}

// ---------------------- Intent: schedule_followup (ES) ---------------------
// Parser mínimo para fechas relativas y absolutas en español.
function parseDueAtSpanish(
  msg: string
): { when: Date; matched: string } | null {
  const now = new Date();
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);

  // mañana / hoy / pasado mañana a las HH[:MM] [am|pm]
  const rel =
    /(pasado\s+ma[ñn]ana|ma[ñn]ana|hoy)\s*(?:a\s+las\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(
      msg
    );
  if (rel) {
    const word = rel[1].toLowerCase();
    const hh = Number(rel[2]);
    const mm = rel[3] ? Number(rel[3]) : 0;
    const ap = rel[4]?.toLowerCase();
    let d = new Date(base);
    if (/pasado/.test(word)) d.setDate(d.getDate() + 2);
    else if (/ma[ñn]ana/.test(word)) d.setDate(d.getDate() + 1);
    let H = hh;
    if (ap === "pm" && H < 12) H += 12;
    if (ap === "am" && H === 12) H = 0;
    d.setHours(H, mm, 0, 0);
    return { when: d, matched: rel[0] };
  }

  // dd/mm a las HH[:MM]
  const abs = /(\d{1,2})\/(\d{1,2}).*?a\s+las\s+(\d{1,2})(?::(\d{2}))?/i.exec(
    msg
  );
  if (abs) {
    const day = Number(abs[1]);
    const mon = Number(abs[2]) - 1;
    const hh = Number(abs[3]);
    const mm = abs[4] ? Number(abs[4]) : 0;
    const d = new Date(base);
    d.setMonth(mon, day);
    d.setHours(hh, mm, 0, 0);
    return { when: d, matched: abs[0] };
  }

  return null;
}

// Extrae título y dueAt a partir de la frase natural.
function extractScheduleFollowUp(text: string) {
  const r = parseDueAtSpanish(text);
  if (!r) return null;
  const raw = stripPunct(text);
  // Quita “agendá/programá … follow-up”, conectores y la parte temporal.
  let title = raw
    .replace(/agend(a|á|ar)\s+un?\s+follow[- ]?up/gi, "")
    .replace(/program(a|á|ar)\s+un?\s+follow[- ]?up/gi, "")
    .replace(
      new RegExp(r.matched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      ""
    )
    .replace(/\b(para|con|sobre)\b/gi, "")
    .trim();
  if (!title || title.length < 3) title = "Follow-up";
  return { title, dueAt: r.when };
}

// ------------------------------ Núcleo del agente --------------------------
// Orquesta fast-paths, herramientas y loop del LLM con fallback a prueba de fallos.
export async function runAgent(
  conversationId: string,
  userMessage: string,
  emit: AgentEventEmitter
) {
  // 0) Carga y persistencia inmediata del mensaje del usuario.
  const session = await getSession(conversationId);
  session.history.push({ role: "user", content: userMessage });
  await saveSession(session);

  // ---- Helper local para invocar tools con validación y telemetría UI.
  type ToolCallOutcome = {
    name: ToolName;
    status: "success" | "error";
    parsedInput: unknown;
    result: unknown;
  };

  const invokeTool = async (
    toolName: string | undefined,
    rawInput: unknown
  ): Promise<ToolCallOutcome | null> => {
    // 1) Verificación de existencia de la tool
    if (!toolName || !(toolName in tools)) {
      emit({
        event: "error",
        data: { message: `Tool desconocida: ${String(toolName)}` },
      });
      session.history.push({
        role: "assistant",
        content: `TOOL_ERROR ${String(toolName)}`,
      });
      await saveSession(session);
      return null;
    }

    const typedName = toolName as ToolName;
    const def = tools[typedName];

    // 2) Parseo/validación del input contra el schema de la tool
    let parsedInput: unknown;
    try {
      parsedInput = def.schema.parse(rawInput ?? {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "input inválido";
      emit({
        event: "error",
        data: { message: `Input inválido para ${typedName}: ${msg}` },
      });
      session.history.push({
        role: "assistant",
        content: `TOOL_INPUT_ERROR ${typedName}: ${msg}`,
      });
      await saveSession(session);
      return null;
    }

    // 3) Señaliza a la UI la invocación de la tool
    const callId = randomUUID();
    emit({
      event: "tool",
      data: { id: callId, name: typedName, input: parsedInput },
    });

    try {
      // 4) Ejecuta la tool y determina status semántico
      const result = await def.execute(parsedInput, { session });
      const status = (result as any)?.success === false ? "error" : "success";

      // 5) Notifica resultado a la UI
      emit({
        event: "tool_result",
        data: {
          id: callId,
          name: typedName,
          input: parsedInput,
          result,
          status,
          error:
            status === "error"
              ? (result as any)?.message ?? "Error desconocido"
              : undefined,
        },
      });

      // 6) Persistencia mínima en historial para auditar flujos
      session.history.push({
        role: "assistant",
        content: `TOOL_CALL ${typedName}: ${JSON.stringify(parsedInput)}`,
      });
      session.history.push({
        role: "assistant",
        content: `TOOL_RESULT ${typedName}: ${JSON.stringify(result)}`,
      });

      // 7) Side-effect: si fue verify_passcode exitoso, fijar usuario autenticado
      if (typedName === "verify_passcode" && status === "success") {
        session.authenticatedUser = (result as any)?.user;
        emit({
          event: "state",
          data: { authenticatedUser: session.authenticatedUser ?? null },
        });
      }

      await saveSession(session);
      return { name: typedName, status, parsedInput, result };
    } catch (err) {
      // 8) Manejo de excepciones en la ejecución de la tool
      const msg = err instanceof Error ? err.message : "Error ejecutando tool";
      emit({
        event: "tool_result",
        data: {
          id: callId,
          name: typedName,
          input: parsedInput,
          result: null,
          status: "error",
          error: msg,
        },
      });
      session.history.push({
        role: "assistant",
        content: `TOOL_EXEC_ERROR ${typedName}: ${msg}`,
      });
      await saveSession(session);
      return null;
    }
  };

  // ---------------------- Helpers de respuesta de tools --------------------
  // Normaliza formateo de mensajes humanos según la tool invocada.
  const formatDateTime = (value: unknown) => {
    if (!value) return null;
    const date =
      value instanceof Date
        ? value
        : new Date(typeof value === "number" ? value : String(value));
    if (Number.isNaN(date.valueOf())) return null;
    return date.toLocaleString();
  };

  const buildToolSuccessMessage = (outcome: ToolCallOutcome): string => {
    const { name, parsedInput, result } = outcome;
    switch (name) {
      case "record_note": {
        const ts =
          (result as any)?.createdAt ??
          (result as any)?.created_at ??
          new Date().toISOString();
        const noteId =
          (result as any)?.noteId ??
          (result as any)?.id ??
          (result as any)?.note?.id ??
          (parsedInput as any)?.noteId;
        const noteText = (result as any)?.text ?? (parsedInput as any)?.text;
        const snippet =
          typeof noteText === "string" && noteText.trim().length
            ? ` Detalle: "${
                noteText.trim().length > 140
                  ? `${noteText.trim().slice(0, 137)}…`
                  : noteText.trim()
              }"`
            : "";
        const when = formatDateTime(ts);
        const timeText = when ? ` el ${when}` : "";
        const idText = noteId ? ` (ID ${noteId})` : "";
        return `Nota guardada${idText}${timeText}.${snippet} ¿Algo más?`;
      }
      case "create_lead": {
        const leadResult = (result as any)?.lead ?? result;
        const leadInput = parsedInput as any;
        const nameValue = leadResult?.name ?? leadInput?.name;
        const email = leadResult?.email ?? leadInput?.email;
        const source = leadResult?.source ?? leadInput?.source;
        const leadId = leadResult?.id ?? (result as any)?.leadId;
        const headline = [
          nameValue ? String(nameValue) : null,
          email ? `<${String(email)}>` : null,
        ]
          .filter(Boolean)
          .join(" ");
        const meta: string[] = [];
        if (leadId) meta.push(`ID ${leadId}`);
        if (source) meta.push(`fuente: ${String(source)}`);
        const suffix = meta.length ? ` (${meta.join(" · ")})` : "";
        return `Lead creado: ${headline || "sin datos"}${suffix}.`;
      }
      case "verify_passcode": {
        const user = (result as any)?.user;
        const nameValue = user?.name ?? (parsedInput as any)?.name;
        return `Usuario verificado: ${nameValue}. ¿Querés registrar un lead, una nota, un follow-up o buscar en la documentación?`;
      }
      case "search_docs": {
        const payload = (result as any) ?? {};
        const matches = Array.isArray(payload.results)
          ? payload.results
          : Array.isArray(result)
          ? (result as any)
          : [];
        const count = matches.length;
        const extras: string[] = [];
        if (payload.question)
          extras.push(`Consulta: "${String(payload.question)}"`);
        if (matches[0]?.path) extras.push(`Ejemplo: ${matches[0].path}`);
        if (payload.source === "static")
          extras.push("Fuente: compendio interno");
        if (count === 0) {
          const baseMessage =
            payload.message ??
            "No encontré fragmentos relevantes en la documentación.";
          const hint =
            payload.source === "none"
              ? " Si tenés más contexto, compartilo y vuelvo a buscar."
              : "";
          return `${baseMessage}${hint}`;
        }
        const extraText = extras.length ? ` ${extras.join(" • ")}` : "";
        return `Encontré ${count} fragmento${
          count === 1 ? "" : "s"
        } relevantes.${extraText} ¿Querés que elabore una respuesta con ellos?`;
      }
      case "list_notes": {
        const notes = Array.isArray((result as any)?.notes)
          ? (result as any).notes
          : [];
        if (notes.length === 0)
          return "No encontré notas registradas todavía. ¿Agendamos una nueva?";
        const lines = notes.slice(0, 10).map((note: any) => {
          const when = formatDateTime(note.createdAt);
          const snippet =
            typeof note.text === "string" && note.text.trim().length
              ? note.text.trim().length > 120
                ? `${note.text.trim().slice(0, 117)}…`
                : note.text.trim()
              : "";
          const meta = [when ? when : null].filter(Boolean).join(" • ");
          return `• [#${note.id}] ${snippet || "(sin detalle)"}${
            meta ? ` • ${meta}` : ""
          }`;
        });
        return `Estas son tus últimas notas (${notes.length}):\n${lines.join(
          "\n"
        )}`;
      }
      case "delete_note": {
        const deleted = (result as any)?.deleted ?? {};
        const when = formatDateTime(deleted.createdAt);
        const snippet =
          typeof deleted.text === "string" && deleted.text.trim().length
            ? deleted.text.trim().length > 120
              ? `${deleted.text.trim().slice(0, 117)}…`
              : deleted.text.trim()
            : "";
        const pieces = [`Nota ${deleted.id} eliminada.`];
        if (snippet) pieces.push(`Contenido: "${snippet}".`);
        if (when) pieces.push(`Creada el ${when}.`);
        pieces.push("¿Te ayudo con algo más?");
        return pieces.join(" ");
      }
      case "list_leads": {
        const leads = Array.isArray((result as any)?.leads)
          ? (result as any).leads
          : [];
        if (leads.length === 0)
          return "No hay leads registrados todavía. ¿Querés crear uno nuevo?";
        const lines = leads.slice(0, 10).map((lead: any) => {
          const created = formatDateTime(lead.createdAt);
          const meta = [
            lead.email ? `<${lead.email}>` : null,
            lead.source ? `fuente: ${lead.source}` : null,
            created,
          ]
            .filter(Boolean)
            .join(" • ");
          return `• [ID ${lead.id}] ${lead.name ?? "Sin nombre"}${
            meta ? ` • ${meta}` : ""
          }`;
        });
        return `Últimos leads (${leads.length}):\n${lines.join("\n")}`;
      }
      case "schedule_followup": {
        const followUp = (result as any)?.followUp ?? result;
        const dueText = formatDateTime(followUp?.dueAt) ?? "sin fecha definida";
        const notes =
          typeof followUp?.notes === "string" && followUp.notes.trim().length
            ? ` Notas: "${
                followUp.notes.trim().length > 120
                  ? `${followUp.notes.trim().slice(0, 117)}…`
                  : followUp.notes.trim()
              }".`
            : "";
        return `Follow-up agendado (ID ${followUp?.id}): "${followUp?.title}" con vencimiento ${dueText}.${notes}`;
      }
      case "list_followups": {
        const followUps = Array.isArray((result as any)?.followUps)
          ? (result as any).followUps
          : [];
        if (followUps.length === 0)
          return "No hay follow-ups en ese estado por ahora. Podemos agendar uno nuevo si querés.";
        const lines = followUps.slice(0, 10).map((item: any) => {
          const due = formatDateTime(item.dueAt) ?? "sin fecha";
          const status =
            item.status === "completed" ? "completado" : "pendiente";
          const notes =
            typeof item.notes === "string" && item.notes.trim().length
              ? ` – ${
                  item.notes.trim().length > 100
                    ? `${item.notes.trim().slice(0, 97)}…`
                    : item.notes.trim()
                }`
              : "";
          return `• [ID ${item.id}] ${item.title} (${status}, vence ${due})${notes}`;
        });
        return `Resumen de follow-ups (${followUps.length}):\n${lines.join(
          "\n"
        )}`;
      }
      case "complete_followup": {
        const followUp = (result as any)?.followUp ?? result;
        const completed = formatDateTime(followUp?.completedAt);
        const due = formatDateTime(followUp?.dueAt);
        const pieces = [`Follow-up ${followUp?.id} marcado como completado.`];
        if (completed) pieces.push(`Cierre: ${completed}.`);
        if (due) pieces.push(`Fecha original: ${due}.`);
        return pieces.join(" ");
      }
      default:
        return (result as any)?.message ?? "Acción completada correctamente.";
    }
  };

  // Responder flujo feliz/errores y persistir en historial.
  const respondWithToolSuccess = async (outcome: ToolCallOutcome) => {
    const message = buildToolSuccessMessage(outcome);
    await emitStreamingText(emit, message);
    session.history.push({ role: "assistant", content: message });
    await saveSession(session);
  };

  const respondWithToolError = async (outcome: ToolCallOutcome) => {
    const msg =
      (outcome.result as any)?.message ??
      `No se pudo ejecutar ${outcome.name}.`;
    await emitStreamingText(emit, msg);
    session.history.push({ role: "assistant", content: msg });
    await saveSession(session);
  };

  // ----------------------------- Estrategia de flujo -----------------------
  // 1) Auth fast-path: si no hay usuario autenticado, intenta extraer passcode.
  if (!session.authenticatedUser) {
    const creds = extractPasscodeIntent(userMessage);
    if (creds) {
      const outcome = await invokeTool("verify_passcode", creds);
      if (outcome) {
        if (outcome.status === "success") {
          await respondWithToolSuccess(outcome);
          return; // auth resuelta
        }
        await respondWithToolError(outcome);
        return; // informar error de auth
      }
    }
  }

  // 2) Acciones y listados si ya está autenticado
  if (session.authenticatedUser) {
    // Completar follow-up
    const done = extractCompleteFollowUp(userMessage);
    if (done) {
      const outcome = await invokeTool("complete_followup", done);
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
      if (outcome) {
        await respondWithToolError(outcome);
        return;
      }
    }

    // Agendar follow-up con fecha
    const sched = extractScheduleFollowUp(userMessage);
    if (sched) {
      const outcome = await invokeTool("schedule_followup", sched);
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
      if (outcome) {
        await respondWithToolError(outcome);
        return;
      }
    }

    // Crear lead rápido
    const lead = extractCreateLead(userMessage);
    if (lead) {
      const outcome = await invokeTool("create_lead", lead);
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
      if (outcome) {
        await respondWithToolError(outcome);
        return;
      }
    }

    // Registrar nota
    const note = extractRecordNote(userMessage);
    if (note) {
      const outcome = await invokeTool("record_note", note);
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
      if (outcome) {
        await respondWithToolError(outcome);
        return;
      }
    }

    // Listados con extracción de límite numérico simple (1–12)
    const normalized = userMessage.toLowerCase();
    const numberMatch = userMessage.match(/\b(\d{1,2})\b/);
    const limit = numberMatch ? Number(numberMatch[1]) : undefined;

    if (
      /nota/.test(normalized) &&
      /(mostr|lista|listá|ver|consult)/.test(normalized)
    ) {
      const outcome = await invokeTool("list_notes", limit ? { limit } : {});
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
      if (outcome) {
        await respondWithToolError(outcome);
        return;
      }
    }

    if (
      /lead/.test(normalized) &&
      /(mostr|lista|listá|ver|consult)/.test(normalized)
    ) {
      const outcome = await invokeTool("list_leads", limit ? { limit } : {});
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
      if (outcome) {
        await respondWithToolError(outcome);
        return;
      }
    }

    if (
      /(follow[- ]?up|seguimiento)/.test(normalized) &&
      /(mostr|lista|listá|ver|consult)/.test(normalized)
    ) {
      const status = /\bpendient/.test(normalized)
        ? "pending"
        : /\bcompletad|completos?\b/.test(normalized)
        ? "completed"
        : undefined;
      const outcome = await invokeTool("list_followups", {
        ...(status ? { status } : {}),
        ...(limit ? { limit } : {}),
      });
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
      if (outcome) {
        await respondWithToolError(outcome);
        return;
      }
    }
  }

  // 3) Búsqueda en docs como último fast-path
  const q = extractSearchDocs(userMessage);
  if (q) {
    const outcome = await invokeTool("search_docs", q);
    if (outcome?.status === "success") {
      await respondWithToolSuccess(outcome);
      return;
    }
    if (outcome) {
      await respondWithToolError(outcome);
      return;
    }
  }

  // 4) LLM loop con límite y reintentos de JSON
  // Define un máximo acotado de iteraciones y hace un retry si el primer
  // contenido no parsea contra PlanSchema.
  const maxIters = Math.min(
    10,
    Math.max(1, Number(process.env.MAX_TOOL_ITERATIONS ?? "4"))
  );

  for (let i = 0; i < maxIters; i++) {
    const contextual = session.authenticatedUser
      ? `Usuario autenticado: ${session.authenticatedUser.id} - ${session.authenticatedUser.name}.`
      : "El usuario no está autenticado. Pedí nombre y passcode y validá con verify_passcode.";

    let content = "";
    try {
      content = await openrouterChat({
        system: `${BASE_PROMPT}\n\n${contextual}`,
        messages: buildMessages(session.history),
        temperature: 0,
        maxTokens: 1024,
      });
    } catch (e) {
      // Error de transporte o proveedor. Se devuelve fallback legible.
      const plan = fallbackPlan(
        e instanceof Error ? e.message : "LLM error",
        Boolean(session.authenticatedUser)
      );
      emit({
        event: "thought",
        data: { id: randomUUID(), text: plan.thought },
      });
      await emitStreamingText(emit, plan.final_response);
      session.history.push({ role: "assistant", content: plan.final_response });
      await saveSession(session);
      return;
    }

    // Intento de parseo principal + retry con prompt más estricto
    let plan: Plan | null = parsePlan(content);
    if (!plan) {
      const retry = await openrouterChat({
        system: `${BASE_PROMPT}\n\nRESPONDE SOLO JSON plano (sin \`\`\`)`,
        messages: buildMessages(session.history),
        temperature: 0,
        maxTokens: 512,
      });
      plan = parsePlan(retry);
    }

    // Si sigue fallando, construir fallback determinista
    plan =
      plan ??
      fallbackPlan(
        "Modelo devolvió JSON inválido",
        Boolean(session.authenticatedUser)
      );

    // Telemetría de pensamiento para UI
    emit({ event: "thought", data: { id: randomUUID(), text: plan.thought } });

    // Branch: ejecutar tool vs responder texto
    if (plan.action === "tool") {
      const outcome = await invokeTool(plan.tool?.name, plan.tool?.input);
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
      if (outcome) {
        await respondWithToolError(outcome);
        return;
      }
      continue; // si outcome fue null por error de parse, permitir otra iteración
    }

    // action === "respond"
    const text = plan.final_response; // por schema, string no vacío
    await emitStreamingText(emit, text);
    session.history.push({ role: "assistant", content: text });
    await saveSession(session);
    return;
  }

  // Límite de iteraciones alcanzado; protegerse contra loops.
  emit({
    event: "error",
    data: {
      message: "El agente alcanzó el límite de iteraciones sin responder.",
    },
  });
}
