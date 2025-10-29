// ──────────────────────────────────────────────────────────────────────────────
// File: src/lib/env.ts — Validación y cacheo de variables de entorno con Zod
// ──────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

/**
 * Esquema de ENV. Define defaults y valida presencia de claves sensibles.
 * - EMBEDDING_DIM impacta el tipo vector(N) en base de datos.
 * - OLLAMA_BASE_URL apunta al contenedor/host del servidor de embeddings.
 * - NEXT_PUBLIC_BACKEND_URL se expone al cliente (prefijo de fetch en frontend).
 */
const schema = z.object({
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().default("openrouter/auto"),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(768),
  OLLAMA_BASE_URL: z.string().default("http://ollama:11434"),
  DATABASE_URL: z.string().min(1),
  DOCS_ROOT: z.string().default("../data"),
  MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(4),
  NEXT_PUBLIC_BACKEND_URL: z.string().optional(),
});

let cached: any; // cache en proceso para evitar reparseos

/**
 * getEnv(): parsea process.env una vez y retorna valores tipados+defaulted.
 * - Recomendado importarlo en capa de servidor; evitar usarlo en client components.
 */
export function getEnv() {
  if (!cached) cached = schema.parse(process.env);
  return cached as z.infer<typeof schema>;
}
