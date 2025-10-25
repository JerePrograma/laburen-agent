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

const PlanSchema = z.object({
  thought: z.string().default(""),
  action: z.enum(["tool", "respond"]),
  tool: z.object({ name: z.string(), input: z.unknown().optional() }).nullable().optional(),
  final_response: z.string().nullable().optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
});

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

// Fast-path: detectar "soy X, mi passcode es Y" sin depender del LLM
function extractPasscodeIntent(text: string): { name: string; passcode: string } | null {
  const nameMatch = text.match(
    /\b(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][\wÁÉÍÓÚÑáéíóúñ .'-]{1,60})/i
  );
  const passMatch = text.match(
    /\b(?:passcode|c(?:ó|o)digo|clave)\s*(?:es|:)?\s*([A-Za-z0-9-]{3,64})/i
  );
  if (nameMatch && passMatch) {
    return { name: nameMatch[1].trim(), passcode: passMatch[1].trim() };
  }
  return null;
}

export async function runAgent(
  conversationId: string,
  userMessage: string,
  emit: AgentEventEmitter
) {
  const session = await getSession(conversationId);
  session.history.push({ role: "user", content: userMessage });
  await saveSession(session);

  // Fast-path de autenticación por regex
  if (!session.authenticatedUser) {
    const creds = extractPasscodeIntent(userMessage);
    if (creds) {
      const callId = randomUUID();
      emit({ event: "tool", data: { id: callId, name: "verify_passcode", input: creds } });
      try {
        const result = await tools.verify_passcode.execute(creds, { session });
        const status = (result as any)?.success === false ? "error" : "success";
        emit({
          event: "tool_result",
          data: {
            id: callId,
            name: "verify_passcode",
            input: creds,
            result,
            status,
            error: status === "error" ? (result as any)?.message : undefined,
          },
        });

        if ((result as any)?.success) {
          session.authenticatedUser = (result as any).user;
          await saveSession(session);
          emit({ event: "state", data: { authenticatedUser: session.authenticatedUser } });

          const ok =
            `Usuario verificado: ${(result as any).user.name}. ` +
            "¿Querés registrar un lead, una nota o buscar en la documentación?";
          await emitStreamingText(emit, ok);
          session.history.push({ role: "assistant", content: ok });
          await saveSession(session);
          return;
        }
        // si falló, continúa al loop LLM
      } catch (e) {
        emit({
          event: "tool_result",
          data: {
            id: callId,
            name: "verify_passcode",
            input: creds,
            result: null,
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          },
        });
        // sigue al loop LLM
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
      const toolName = plan.tool?.name as ToolName | undefined;
      if (!toolName || !(toolName in tools)) {
        emit({ event: "error", data: { message: `Tool desconocida: ${String(toolName)}` } });
        session.history.push({ role: "assistant", content: `TOOL_ERROR ${String(toolName)}` });
        await saveSession(session);
        continue;
      }

      const def = tools[toolName];
      let parsedInput: unknown;
      try {
        parsedInput = def.schema.parse(plan.tool?.input ?? {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : "input inválido";
        emit({ event: "error", data: { message: `Input inválido para ${toolName}: ${msg}` } });
        session.history.push({
          role: "assistant",
          content: `TOOL_INPUT_ERROR ${toolName}: ${msg}`,
        });
        await saveSession(session);
        continue;
      }

      const callId = randomUUID();
      emit({ event: "tool", data: { id: callId, name: toolName, input: parsedInput } });

      try {
        const result = await def.execute(parsedInput, { session });
        const status = (result as any)?.success === false ? "error" : "success";
        emit({
          event: "tool_result",
          data: {
            id: callId,
            name: toolName,
            input: parsedInput,
            result,
            status,
            error: status === "error" ? (result as any)?.message ?? "Error desconocido" : undefined,
          },
        });

        session.history.push({
          role: "assistant",
          content: `TOOL_CALL ${toolName}: ${JSON.stringify(parsedInput)}`,
        });
        session.history.push({
          role: "assistant",
          content: `TOOL_RESULT ${toolName}: ${JSON.stringify(result)}`,
        });

        if (toolName === "verify_passcode" && (result as any)?.success) {
          session.authenticatedUser = (result as any).user;
          emit({
            event: "state",
            data: { authenticatedUser: session.authenticatedUser ?? null },
          });
        }

        await saveSession(session);

        if (status === "success") {
          let text = "Acción completada correctamente.";
          if (toolName === "record_note") {
            const ts = (result as any)?.createdAt ?? new Date().toISOString();
            const id = (result as any)?.noteId ?? "?";
            const noteText = (result as any)?.text ?? (parsedInput as any)?.text;
            const snippet =
              typeof noteText === "string" && noteText.trim().length
                ? ` Detalle: "${
                    noteText.trim().length > 120
                      ? `${noteText.trim().slice(0, 117)}…`
                      : noteText.trim()
                  }"`
                : "";
            text = `Nota guardada (ID ${id}) el ${new Date(ts).toLocaleString()}.${snippet} ¿Algo más?`;
          } else if (toolName === "create_lead") {
            const leadResult = (result as any)?.lead ?? result;
            const leadInput = parsedInput as any;
            const name = leadResult?.name ?? leadInput?.name;
            const email = leadResult?.email ?? leadInput?.email;
            const source = leadResult?.source ?? leadInput?.source;
            const leadId = leadResult?.id ?? (result as any)?.leadId;
            const headline = [name ? String(name) : null, email ? `<${String(email)}>` : null]
              .filter(Boolean)
              .join(" ");
            const meta: string[] = [];
            if (leadId) meta.push(`ID ${leadId}`);
            if (source) meta.push(`fuente: ${String(source)}`);
            const suffix = meta.length ? ` (${meta.join(" · ")})` : "";
            text = `Lead creado: ${headline || "sin datos"}${suffix}.`;
          } else if (toolName === "verify_passcode") {
            const u = (result as any)?.user;
            text = `Usuario verificado: ${u?.name}. ¿Querés registrar un lead, una nota o buscar en la documentación?`;
          } else if (toolName === "search_docs") {
            const payload = (result as any) ?? {};
            const matches = Array.isArray(payload.results)
              ? payload.results
              : Array.isArray(result)
              ? result
              : [];
            const k = matches.length;
            const extras: string[] = [];
            const firstPath = matches[0]?.path;
            if (firstPath) extras.push(`Ejemplo: ${firstPath}`);
            if (payload.question) extras.push(`Consulta: "${String(payload.question)}"`);
            const extraText = extras.length ? ` ${extras.join(" • ")}` : "";
            text = `Encontré ${k} fragmento${k === 1 ? "" : "s"} relevantes.${extraText} ¿Querés que elabore una respuesta con ellos?`;
          }

          await emitStreamingText(emit, text);
          session.history.push({ role: "assistant", content: text });
          await saveSession(session);
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Error ejecutando tool";
        emit({
          event: "tool_result",
          data: { id: callId, name: toolName, input: parsedInput, result: null, status: "error", error: msg },
        });
        session.history.push({ role: "assistant", content: `TOOL_EXEC_ERROR ${toolName}: ${msg}` });
        await saveSession(session);
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
