import { z } from "zod";
import { query } from "@/lib/db";
import { searchDocuments } from "@/lib/rag";
import type { AgentSession } from "@/lib/session-store";

export interface ToolExecutionContext { session: AgentSession; }
export interface ToolDefinition<TInput = any, TResult = any> {
  name: string; description: string;
  schema: z.ZodType<TInput>;
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TResult>;
}
export type ToolRegistry = Record<string, ToolDefinition<any, any>>;

const verifyPasscodeSchema = z.object({
  name: z.string(),
  passcode: z.string().min(1),
});
const createLeadSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  source: z.string().optional(),
});
const noteSchema = z.object({ text: z.string().min(1) });
const searchSchema = z.object({ question: z.string().min(1) });

export const tools: ToolRegistry = {
  verify_passcode: {
    name: "verify_passcode",
    description: "Valida usuario invitado por nombre+passcode.",
    schema: verifyPasscodeSchema,
    async execute(input) {
      const r = await query<{ id: number; name: string }>(
        `SELECT id, name FROM invited_user
         WHERE LOWER(name) = LOWER($1) AND passcode = $2
         LIMIT 1`,
        [input.name.trim(), input.passcode.trim()]
      );
      if (r.rowCount === 0) return { success: false, message: "Nombre o código inválido" };
      return { success: true, user: r.rows[0], message: `Usuario verificado: ${r.rows[0].name}` };
    },
  },
  create_lead: {
    name: "create_lead",
    description: "Crea un lead potencial.",
    schema: createLeadSchema,
    async execute(input, ctx) {
      if (!ctx.session.authenticatedUser) return { success: false, message: "No autenticado" };
      const name = input.name.trim(), email = input.email.trim(), source = input.source?.trim();
      const r = await query<{ id: number; created_at: string }>(
        `INSERT INTO lead(name, email, source) VALUES ($1,$2,$3) RETURNING id, created_at`,
        [name, email, source ?? null]
      );
      return { success: true, lead: { id: r.rows[0].id, name, email, source: source ?? null, createdAt: r.rows[0].created_at }, message: "Lead registrado" };
    },
  },
  record_note: {
    name: "record_note",
    description: "Guarda una nota vinculada al usuario autenticado.",
    schema: noteSchema,
    async execute(input, ctx) {
      if (!ctx.session.authenticatedUser) return { success: false, message: "No autenticado" };
      const text = input.text.trim();
      const r = await query<{ id: number; created_at: string }>(
        `INSERT INTO note(user_id, text) VALUES ($1,$2) RETURNING id, created_at`,
        [ctx.session.authenticatedUser.id, text]
      );
      return { success: true, noteId: r.rows[0].id, createdAt: r.rows[0].created_at, text, message: "Nota guardada" };
    },
  },
  search_docs: {
    name: "search_docs",
    description: "Busca en la base vectorial.",
    schema: searchSchema,
    async execute(input) {
      const results = await searchDocuments(input.question);
      return { success: true, question: input.question, results };
    },
  },
};
