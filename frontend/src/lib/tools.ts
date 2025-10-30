/**
 * src/lib/tools.ts — Registro de herramientas (Tools) del agente
 *
 * Propósito: definir schema (zod) + ejecución (execute) de cada herramienta
 * disponible para el agente. Cada tool valida su input y realiza I/O contra
 * Postgres mediante `query`. El agente orquestador (agent.ts) resuelve cuándo
 * invocarlas y cómo presentar sus resultados.
 *
 * Ideas base del diseño:
 * - Tipos fuertes: cada tool trae su Zod schema. Se rechaza input inválido.
 * - Seguridad: SQL parametrizado evita inyección. Autorización por `session`.
 * - UX: cada tool devuelve un objeto con `success`, `message` y payload útil.
 * - Escalabilidad: conviene agregar índices a tablas consultadas con frecuencia.
 *
 * Dependencias DB implícitas:
 *   invited_user(id, name, passcode)
 *   lead(id, name, email, source, created_at)
 *   note(id, user_id, text, created_at)
 *   follow_up(id, user_id, title, due_at, notes, status, created_at, completed_at)
 *
 * Notas:
 * - `verify_passcode` usa unaccent/lower: requiere extensión `unaccent` en Postgres.
 * - `list_leads` es pública en este diseño: no exige auth (revisar privacidad).
 */

import { z } from "zod";
import { query } from "@/lib/db";
import { searchDocuments } from "@/lib/rag"; // Mantener la ruta acorde a tu estructura
import type { AgentSession } from "@/lib/session-store";

// Contexto que reciben las tools: hoy sólo session, extensible a más (tenant, traceId, etc.)
export interface ToolExecutionContext {
  session: AgentSession;
}

// Definición canónica de una herramienta
export interface ToolDefinition<TInput = any, TResult = any> {
  name: string; // clave pública de la tool
  description: string; // explicación breve para prompts/UI
  schema: z.ZodType<TInput>; // validación fuerte del input
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TResult>; // efecto principal
}

// Registro indexado por nombre de tool
export type ToolRegistry = Record<string, ToolDefinition<any, any>>;

// ------------------------------ Schemas (Zod) ------------------------------
// Validan inputs de usuario/LLM antes de tocar la base de datos.

// Auth por passcode: nombre libre + passcode no vacío
const verifyPasscodeSchema = z.object({
  name: z.string(),
  passcode: z.string().min(1),
});

// Alta de lead: email válido. `source` opcional para tracking.
const createLeadSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  source: z.string().optional(),
});

// Nota: texto no vacío. Se guarda para el usuario autenticado.
const noteSchema = z.object({ text: z.string().min(1) });

// Listado de notas: límite sano y acotado a 50.
const listNotesSchema = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
});

// Búsqueda semántica: pregunta no vacía.
const searchSchema = z.object({ question: z.string().min(1) });

// Borrado de nota por ID entero positivo.
const deleteNoteSchema = z.object({
  noteId: z.coerce.number().int().positive(),
});

// Listado de leads: no requiere auth en este diseño, sólo límite.
const listLeadsSchema = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
});

// Estados válidos de follow-up: enum estable.
const followUpStatusSchema = z.enum(["pending", "completed"]);

// Agendado de follow-up: título requerido, dueAt coercionado a Date si viene.
const scheduleFollowupSchema = z.object({
  title: z.string().min(1),
  dueAt: z.coerce.date().optional(),
  notes: z.string().optional(),
});

// Listado de follow-ups: por estado opcional + límite.
const listFollowupsSchema = z.object({
  status: followUpStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

// Completar follow-up por ID entero positivo.
const completeFollowupSchema = z.object({
  followUpId: z.coerce.number().int().positive(),
});

// ------------------------------- Tools -------------------------------------
// Cada tool aplica su schema y ejecuta su operación. Devuelve un objeto
// simple apto para serializar en historial y presentar en UI.

export const tools: ToolRegistry = {
  // ─────────────────────────── verify_passcode ───────────────────────────
  verify_passcode: {
    name: "verify_passcode",
    description: "Valida usuario invitado por nombre+passcode.",
    schema: verifyPasscodeSchema,
    async execute(input) {
      // Búsqueda insensible a mayúsculas/acentos. Requiere extensión unaccent.
      const r = await query<{ id: number; name: string }>(
        `SELECT id, name
           FROM invited_user
          WHERE unaccent(lower(name)) = unaccent(lower(trim($1)))
            AND passcode = $2
          LIMIT 1`,
        [input.name.trim(), input.passcode.trim()]
      );
      if (r.rowCount === 0)
        return { success: false, message: "Nombre o código inválido" };
      return {
        success: true,
        user: r.rows[0],
        message: `Usuario verificado: ${r.rows[0].name}`,
      };
    },
  },

  // ────────────────────────────── create_lead ─────────────────────────────
  create_lead: {
    name: "create_lead",
    description: "Crea un lead potencial.",
    schema: createLeadSchema,
    async execute(input, ctx) {
      // Autorización: exige usuario autenticado.
      if (!ctx.session.authenticatedUser)
        return { success: false, message: "No autenticado" };

      const name = input.name.trim();
      const email = input.email.trim();
      const source = input.source?.trim();

      const r = await query<{ id: number; created_at: string }>(
        `INSERT INTO lead(name, email, source) VALUES ($1,$2,$3) RETURNING id, created_at`,
        [name, email, source ?? null]
      );

      return {
        success: true,
        lead: {
          id: r.rows[0].id,
          name,
          email,
          source: source ?? null,
          createdAt: r.rows[0].created_at,
        },
        message: "Lead registrado",
      };
    },
  },

  // ────────────────────────────── record_note ─────────────────────────────
  record_note: {
    name: "record_note",
    description: "Guarda una nota vinculada al usuario autenticado.",
    schema: noteSchema,
    async execute(input, ctx) {
      if (!ctx.session.authenticatedUser)
        return { success: false, message: "No autenticado" };

      const text = input.text.trim();
      const r = await query<{ id: number; created_at: string }>(
        `INSERT INTO note(user_id, text) VALUES ($1,$2) RETURNING id, created_at`,
        [ctx.session.authenticatedUser.id, text]
      );

      return {
        success: true,
        noteId: r.rows[0].id,
        createdAt: r.rows[0].created_at,
        text,
        message: "Nota guardada",
      };
    },
  },

  // ─────────────────────────────── list_notes ─────────────────────────────
  list_notes: {
    name: "list_notes",
    description: "Recupera notas previas del usuario autenticado.",
    schema: listNotesSchema,
    async execute(input, ctx) {
      if (!ctx.session.authenticatedUser)
        return { success: false, message: "No autenticado" };

      const limit = input.limit ?? 10;
      const r = await query<{ id: number; text: string; created_at: string }>(
        `SELECT id, text, created_at
           FROM note
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [ctx.session.authenticatedUser.id, limit]
      );

      return {
        success: true,
        notes: r.rows.map((row) => ({
          id: row.id,
          text: row.text,
          createdAt: row.created_at,
        })),
        message:
          r.rowCount === 0
            ? "No se encontraron notas previas."
            : `Se recuperaron ${r.rowCount} nota${
                r.rowCount === 1 ? "" : "s"
              }.`,
      };
    },
  },

  // ─────────────────────────────── delete_note ────────────────────────────
  delete_note: {
    name: "delete_note",
    description: "Elimina una nota propia por ID.",
    schema: deleteNoteSchema,
    async execute(input, ctx) {
      if (!ctx.session.authenticatedUser)
        return { success: false, message: "No autenticado" };

      const noteId = Number(input.noteId);
      const r = await query<{ id: number; text: string; created_at: string }>(
        `DELETE FROM note WHERE id = $1 AND user_id = $2 RETURNING id, text, created_at`,
        [noteId, ctx.session.authenticatedUser.id]
      );

      if (r.rowCount === 0) {
        return {
          success: false,
          message: "No se encontró una nota con ese ID",
        };
      }

      const row = r.rows[0];
      return {
        success: true,
        deleted: { id: row.id, text: row.text, createdAt: row.created_at },
        message: `Nota ${row.id} eliminada`,
      };
    },
  },

  // ─────────────────────────────── list_leads ─────────────────────────────
  list_leads: {
    name: "list_leads",
    description: "Enumera leads recientes registrados en el sistema.",
    schema: listLeadsSchema,
    async execute(input) {
      const limit = input.limit ?? 10;
      const r = await query<{
        id: number;
        name: string;
        email: string;
        source: string | null;
        created_at: string;
      }>(
        `SELECT id, name, email, source, created_at
           FROM lead
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit]
      );

      return {
        success: true,
        leads: r.rows.map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          source: row.source,
          createdAt: row.created_at,
        })),
        message:
          r.rowCount === 0
            ? "No hay leads registrados todavía."
            : `Se listaron ${r.rowCount} lead${r.rowCount === 1 ? "" : "s"}.`,
      };
    },
  },

  // ──────────────────────────── schedule_followup ─────────────────────────
  schedule_followup: {
    name: "schedule_followup",
    description: "Agenda un follow-up para el usuario autenticado.",
    schema: scheduleFollowupSchema,
    async execute(input, ctx) {
      if (!ctx.session.authenticatedUser)
        return { success: false, message: "No autenticado" };

      const title = input.title.trim();
      // `dueAt` puede venir como Date por z.coerce; se serializa a ISO o null
      const dueAt = input.dueAt ? input.dueAt.toISOString() : null;
      const notes = input.notes?.trim() || null;

      const r = await query<{
        id: number;
        created_at: string;
        due_at: string | null;
      }>(
        `INSERT INTO follow_up(user_id, title, due_at, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at, due_at`,
        [ctx.session.authenticatedUser.id, title, dueAt, notes]
      );

      return {
        success: true,
        followUp: {
          id: r.rows[0].id,
          title,
          dueAt: r.rows[0].due_at,
          notes,
          status: "pending" as const,
          createdAt: r.rows[0].created_at,
        },
        message: "Follow-up agendado",
      };
    },
  },

  // ────────────────────────────── list_followups ──────────────────────────
  list_followups: {
    name: "list_followups",
    description: "Enumera follow-ups del usuario autenticado.",
    schema: listFollowupsSchema,
    async execute(input, ctx) {
      if (!ctx.session.authenticatedUser)
        return { success: false, message: "No autenticado" };

      const status = input.status ?? "pending";
      const limit = input.limit ?? 10;

      const r = await query<{
        id: number;
        title: string;
        due_at: string | null;
        notes: string | null;
        status: string;
        created_at: string;
        completed_at: string | null;
      }>(
        `SELECT id, title, due_at, notes, status, created_at, completed_at
           FROM follow_up
          WHERE user_id = $1 AND status = $2
          ORDER BY COALESCE(due_at, created_at) ASC
          LIMIT $3`,
        [ctx.session.authenticatedUser.id, status, limit]
      );

      return {
        success: true,
        followUps: r.rows.map((row) => ({
          id: row.id,
          title: row.title,
          dueAt: row.due_at,
          notes: row.notes,
          status: row.status,
          createdAt: row.created_at,
          completedAt: row.completed_at,
        })),
        message:
          r.rowCount === 0
            ? "No hay follow-ups en ese estado."
            : `Se listaron ${r.rowCount} follow-up${
                r.rowCount === 1 ? "" : "s"
              }.`,
      };
    },
  },

  // ───────────────────────────── complete_followup ────────────────────────
  complete_followup: {
    name: "complete_followup",
    description: "Marca como completado un follow-up propio.",
    schema: completeFollowupSchema,
    async execute(input, ctx) {
      if (!ctx.session.authenticatedUser)
        return { success: false, message: "No autenticado" };

      const followUpId = Number(input.followUpId);
      const r = await query<{
        id: number;
        title: string;
        completed_at: string;
        due_at: string | null;
      }>(
        `UPDATE follow_up
            SET status = 'completed', completed_at = now()
          WHERE id = $1 AND user_id = $2
          RETURNING id, title, completed_at, due_at`,
        [followUpId, ctx.session.authenticatedUser.id]
      );

      if (r.rowCount === 0) {
        return {
          success: false,
          message: "No se encontró un follow-up con ese ID",
        };
      }

      const row = r.rows[0];
      return {
        success: true,
        followUp: {
          id: row.id,
          title: row.title,
          completedAt: row.completed_at,
          dueAt: row.due_at,
          status: "completed" as const,
        },
        message: `Follow-up ${row.id} completado`,
      };
    },
  },

  // ──────────────────────────────── search_docs ───────────────────────────
  search_docs: {
    name: "search_docs",
    description: "Busca en la base vectorial.",
    schema: searchSchema,
    async execute(input) {
      // Delegación al motor RAG (pgvector). El filtrado/ordenamiento se resuelve allí.
      const results = await searchDocuments(input.question);
      if (results.length > 0) {
        return {
          success: true,
          question: input.question,
          results,
          source: "vector" as const,
        };
      }

      const fallback = fallbackDocSearch(input.question);
      if (fallback.length > 0) {
        return {
          success: true,
          question: input.question,
          results: fallback,
          source: "static" as const,
        };
      }

      return {
        success: true,
        question: input.question,
        results: [],
        source: "none" as const,
        message:
          "No encontré material relacionado en la documentación cargada.",
      };
    },
  },
};
