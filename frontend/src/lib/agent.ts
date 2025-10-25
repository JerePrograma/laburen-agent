import { randomUUID } from "crypto";
import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import { delay } from "@/lib/utils";
import { getSession, saveSession } from "@/lib/session-store";
import { tools } from "@/lib/tools";
type ToolName = keyof typeof tools;
import type { AgentMessage } from "@/lib/types";
import { openrouterChat } from "@/lib/openrouter";

interface AgentJSONPlan {
  thought: string;
  action: "tool" | "respond";
  tool?: { name: ToolName; input?: unknown } | null;
  final_response?: string | null;
  confidence?: "low" | "medium" | "high";
}

export type AgentEvent =
  | { event: "thought"; data: { id: string; text: string } }
  | { event: "tool"; data: { id: string; name: string; input: unknown } }
  | { event: "tool_result"; data: { id: string; name: string; input: unknown; result: unknown; status: "success" | "error"; error?: string } }
  | { event: "assistant_message"; data: { id: string } }
  | { event: "assistant_done"; data: { id: string } }
  | { event: "token"; data: { id: string; value: string } }
  | { event: "state"; data: { authenticatedUser?: { id: number; name: string } | null } }
  | { event: "error"; data: { message: string } };

export type AgentEventEmitter = (event: AgentEvent) => void;

const TOOL_NAMES = Object.keys(tools) as [string, ...string[]];

const PlanSchema = z.discriminatedUnion("action", [
  z.object({
    thought: z.string().default(""),
    action: z.literal("tool"),
    tool: z.object({
      name: z.enum(TOOL_NAMES),
      input: z.unknown().optional(),
    }),
    final_response: z.null().optional(),
    confidence: z.enum(["low","medium","high"]).optional(),
  }),
  z.object({
    thought: z.string().default(""),
    action: z.literal("respond"),
    final_response: z.string().min(1),
    tool: z.null().optional(),
    confidence: z.enum(["low","medium","high"]).optional(),
  }),
]);

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

// Mapeo de historial a mensajes para el LLM
type ORMessage = { role: "user" | "assistant"; content: string };
const buildMessages = (history: AgentMessage[]): ORMessage[] =>
  history.map((m) => ({ role: m.role, content: m.content }));

// Streaming en chunks pequeños
function chunkResponse(text: string) {
  const words = text.split(/(\s+)/).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  for (const w of words) {
    buf += w;
    if (buf.length >= 18) {
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [text];
}

function parsePlan(raw: string) {
  const tryParse = (s: string) => {
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
    const repaired = jsonrepair(raw);
    return tryParse(repaired);
  } catch {
    return null;
  }
}

function fallbackPlan(reason: string, authenticated: boolean): AgentJSONPlan {
  return {
    thought: `Fallback: ${reason}`,
    action: "respond",
    tool: null,
    final_response: authenticated
      ? "Hubo un problema al interpretar la respuesta del asistente. Podés intentar de nuevo."
      : "Acceso por invitación con passcode. ¿Querés registrar un lead, una nota o buscar en la documentación?",
    confidence: "low",
  };
}

async function emitStreamingText(emit: AgentEventEmitter, text: string) {
  const id = randomUUID();
  emit({ event: "assistant_message", data: { id } });
  for (const chunk of chunkResponse(text)) {
    emit({ event: "token", data: { id, value: chunk } });
    await delay(30);
  }
  emit({ event: "assistant_done", data: { id } });
  return id;
}

const stripPunct = (s: string) =>
  s.replace(/^[^A-Za-zÁÉÍÓÚÑáéíóúñ]+|[^A-Za-zÁÉÍÓÚÑáéíóúñ' -]+$/g, "")
   .replace(/\s+/g, " ").trim();

function extractPasscodeIntent(text: string): { name: string; passcode: string } | null {
  const nameRe = /\b(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ' -]{1,60}?)(?=[,.;:!?)]|\s|$)/i;
  const passRe = /\b(?:passcode|c(?:ó|o)digo|clave)\s*(?:es|:)?\s*([A-Za-z0-9-]{3,64})\b/i;
  const nameMatch = nameRe.exec(text);
  const passMatch = passRe.exec(text);
  if (!nameMatch || !passMatch) return null;
  const name = stripPunct(nameMatch[1]);
  const passcode = passMatch[1].trim();
  if (!name || !passcode) return null;
  return { name, passcode };
}

export async function runAgent(
  conversationId: string,
  userMessage: string,
  emit: AgentEventEmitter
) {
  const session = await getSession(conversationId);
  session.history.push({ role: "user", content: userMessage });
  await saveSession(session);

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
    if (!toolName || !(toolName in tools)) {
      emit({ event: "error", data: { message: `Tool desconocida: ${String(toolName)}` } });
      session.history.push({
        role: "assistant",
        content: `TOOL_ERROR ${String(toolName)}`,
      });
      await saveSession(session);
      return null;
    }

    const typedName = toolName as ToolName;
    const def = tools[typedName];
    let parsedInput: unknown;
    try {
      parsedInput = def.schema.parse(rawInput ?? {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "input inválido";
      emit({ event: "error", data: { message: `Input inválido para ${typedName}: ${msg}` } });
      session.history.push({
        role: "assistant",
        content: `TOOL_INPUT_ERROR ${typedName}: ${msg}`,
      });
      await saveSession(session);
      return null;
    }

    const callId = randomUUID();
    emit({ event: "tool", data: { id: callId, name: typedName, input: parsedInput } });

    try {
      const result = await def.execute(parsedInput, { session });
      const status = (result as any)?.success === false ? "error" : "success";
      emit({
        event: "tool_result",
        data: {
          id: callId,
          name: typedName,
          input: parsedInput,
          result,
          status,
          error: status === "error" ? (result as any)?.message ?? "Error desconocido" : undefined,
        },
      });

      session.history.push({
        role: "assistant",
        content: `TOOL_CALL ${typedName}: ${JSON.stringify(parsedInput)}`,
      });
      session.history.push({
        role: "assistant",
        content: `TOOL_RESULT ${typedName}: ${JSON.stringify(result)}`,
      });

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
        const headline = [nameValue ? String(nameValue) : null, email ? `<${String(email)}>` : null]
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
        if (matches[0]?.path) extras.push(`Ejemplo: ${matches[0].path}`);
        if (payload.question) extras.push(`Consulta: "${String(payload.question)}"`);
        const extraText = extras.length ? ` ${extras.join(" • ")}` : "";
        return `Encontré ${count} fragmento${count === 1 ? "" : "s"} relevantes.${extraText} ¿Querés que elabore una respuesta con ellos?`;
      }
      case "list_notes": {
        const notes = Array.isArray((result as any)?.notes) ? (result as any).notes : [];
        if (notes.length === 0) {
          return "No encontré notas registradas todavía. ¿Agendamos una nueva?";
        }
        const lines = notes.slice(0, 10).map((note: any) => {
          const when = formatDateTime(note.createdAt);
          const snippet =
            typeof note.text === "string" && note.text.trim().length
              ? note.text.trim().length > 120
                ? `${note.text.trim().slice(0, 117)}…`
                : note.text.trim()
              : "";
          const meta = [when ? when : null].filter(Boolean).join(" • ");
          return `• [#${note.id}] ${snippet || "(sin detalle)"}${meta ? ` • ${meta}` : ""}`;
        });
        return `Estas son tus últimas notas (${notes.length}):\n${lines.join("\n")}`;
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
        const leads = Array.isArray((result as any)?.leads) ? (result as any).leads : [];
        if (leads.length === 0) {
          return "No hay leads registrados todavía. ¿Querés crear uno nuevo?";
        }
        const lines = leads.slice(0, 10).map((lead: any) => {
          const created = formatDateTime(lead.createdAt);
          const meta = [lead.email ? `<${lead.email}>` : null, lead.source ? `fuente: ${lead.source}` : null, created]
            .filter(Boolean)
            .join(" • ");
          return `• [ID ${lead.id}] ${lead.name ?? "Sin nombre"}${meta ? ` • ${meta}` : ""}`;
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
        const followUps = Array.isArray((result as any)?.followUps) ? (result as any).followUps : [];
        if (followUps.length === 0) {
          return "No hay follow-ups en ese estado por ahora. Podemos agendar uno nuevo si querés.";
        }
        const lines = followUps.slice(0, 10).map((item: any) => {
          const due = formatDateTime(item.dueAt) ?? "sin fecha";
          const status = item.status === "completed" ? "completado" : "pendiente";
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
        return `Resumen de follow-ups (${followUps.length}):\n${lines.join("\n")}`;
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

  const respondWithToolSuccess = async (outcome: ToolCallOutcome) => {
    const message = buildToolSuccessMessage(outcome);
    await emitStreamingText(emit, message);
    session.history.push({ role: "assistant", content: message });
    await saveSession(session);
  };

  // Fast-path de autenticación por regex
  if (!session.authenticatedUser) {
    const creds = extractPasscodeIntent(userMessage);
    if (creds) {
      const outcome = await invokeTool("verify_passcode", creds);
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
    }
  }

  const normalized = userMessage.toLowerCase();
  if (session.authenticatedUser) {
    const numberMatch = userMessage.match(/\b(\d{1,2})\b/);
    const limit = numberMatch ? Number(numberMatch[1]) : undefined;

    const wantsNoteList =
      /nota/.test(normalized) && /(mostr|lista|listá|ver|consult)/.test(normalized);
    if (wantsNoteList) {
      const outcome = await invokeTool("list_notes", limit ? { limit } : {});
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
    }

    const wantsLeadList =
      /lead/.test(normalized) && /(mostr|lista|listá|ver|consult)/.test(normalized);
    if (wantsLeadList) {
      const outcome = await invokeTool("list_leads", limit ? { limit } : {});
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
    }

    const wantsFollowupList =
      /(follow[- ]?up|seguimiento)/.test(normalized) &&
      /(mostr|lista|listá|ver|consult|pendient|completad|completos?)/.test(normalized);
    if (wantsFollowupList) {
      const status = /completad|completos?/.test(normalized)
        ? "completed"
        : /pendient/.test(normalized)
        ? "pending"
        : undefined;
      const outcome = await invokeTool("list_followups", {
        ...(status ? { status } : {}),
        ...(limit ? { limit } : {}),
      });
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
    }
  }

  const maxIters = Math.min(10, Math.max(1, Number(process.env.MAX_TOOL_ITERATIONS ?? "4")));

  for (let i = 0; i < maxIters; i++) {
    const contextual = session.authenticatedUser
      ? `Usuario autenticado: ${session.authenticatedUser.id} - ${session.authenticatedUser.name}.`
      : "El usuario no está autenticado. Pedí nombre y passcode y validá con verify_passcode.";

    let content = "";
    try {
      content = await openrouterChat({
        system: `${BASE_PROMPT}\n\n${contextual}`,
        messages: buildMessages(session.history),
        temperature: 0, // menor aleatoriedad para JSON estable
        maxTokens: 1024,
      });
    } catch (e) {
      const plan = fallbackPlan(
        e instanceof Error ? e.message : "LLM error",
        Boolean(session.authenticatedUser)
      );
      emit({ event: "thought", data: { id: randomUUID(), text: plan.thought } });
      await emitStreamingText(emit, plan.final_response ?? "");
      session.history.push({ role: "assistant", content: plan.final_response ?? "" });
      await saveSession(session);
      return;
    }

    const plan =
      parsePlan(content) ??
      fallbackPlan("Modelo devolvió JSON inválido", Boolean(session.authenticatedUser));
    emit({ event: "thought", data: { id: randomUUID(), text: plan.thought } });

    if (plan.action === "tool") {
      const outcome = await invokeTool(plan.tool?.name, plan.tool?.input);
      if (outcome?.status === "success") {
        await respondWithToolSuccess(outcome);
        return;
      }
      continue;
    }

    // Respuesta directa
    const text = plan.final_response ?? "";
    await emitStreamingText(emit, text);
    session.history.push({ role: "assistant", content: text });
    await saveSession(session);
    return;
  }

  emit({ event: "error", data: { message: "El agente alcanzó el límite de iteraciones sin responder." } });
}