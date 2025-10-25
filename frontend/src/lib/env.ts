import { z } from "zod";

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

let cached: any; // cache en proceso
export function getEnv() {
  if (!cached) cached = schema.parse(process.env);
  return cached as z.infer<typeof schema>;
}
