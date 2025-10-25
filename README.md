# Laburen AI Agent

Agente conversacional de producto: autenticación vía chat, RAG sobre documentación local y tools reales contra Postgres. Diseñado para el challenge de Product Engineer de Laburen.

## Stack y arquitectura

- **App**: Next.js 14 (App Router) en `frontend/` — UI de chat y API.
- **LLM**: OpenRouter (modelo configurable; por defecto `openrouter/auto`).
- **Embeddings**: Ollama (`nomic-embed-text`) vía HTTP local.
- **DB**: Postgres + pgvector (Docker).
- **Tools**:
  - `verify_passcode`: valida nombre + passcode en `invited_user`.
  - `create_lead`: inserta en `lead`.
  - `record_note`: guarda notas asociadas.
  - `list_notes`: lista notas previas del usuario autenticado.
  - `delete_note`: elimina una nota existente del usuario autenticado.
  - `list_leads`: enumera los leads más recientes cargados en la base.
  - `schedule_followup`: agenda un seguimiento en la tabla `follow_up`.
  - `list_followups`: muestra follow-ups pendientes o completados.
  - `complete_followup`: marca un follow-up como cerrado.
  - `search_docs`: RAG con `doc_chunk` usando `<=>` (cosine).
- **RAG**: Markdown en `/data`, indexados con `scripts/ingest.ts`.
- **Streaming**: SSE (pensamientos, tools, tokens).
- **Transparencia**: panel en UI con trazas y errores.

## Requisitos

- Node.js 20+ (recomendado 22.x)
- npm
- Docker + Docker Compose
- API key de OpenRouter (https://openrouter.ai)
- Ollama en local (para embeddings)

## Configuración

1) **Clonar** y crear `.env` en la raíz del repo:
```bash
cp .env.example .env
```

Valores esperados (ejemplo):

```env
# Compartidas por frontend/API (server-side)
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openrouter/auto

# Embeddings con Ollama
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text
OLLAMA_BASE_URL=http://localhost:11434

# Postgres
DATABASE_URL=postgres://app:app@127.0.0.1:5432/laburen_ai_agent

# RAG
DOCS_ROOT=../data
MAX_TOOL_ITERATIONS=4

# Cliente
NEXT_PUBLIC_BACKEND_URL=http://localhost:3000
```

2. **Base de datos** (pgvector):

```bash
docker compose up -d
```

> El compose crea la DB y (si está configurado) aplica `server/db/init.sql`.

3. **Ollama** (embeddings locales):

```bash
# Instalar y arrancar Ollama según tu OS
ollama pull nomic-embed-text
# Ollama sirve en http://localhost:11434
```

4. **Instalar dependencias**:

```bash
cd frontend
npm install
```

5. **Ingestar documentos** de `/data`:

```bash
npm run ingest
```

6. **Arrancar en desarrollo**:

```bash
npm run dev
# http://localhost:3000
```

## Uso esperado

1. Presentate con nombre + passcode (ver seeds en `server/db/init.sql`).
2. El agente ejecuta `verify_passcode`.
3. Podés crear leads, registrar/consultar/eliminar notas, agendar y listar follow-ups, y preguntar por la documentación (RAG).
4. La UI muestra pasos, tools y tokens en tiempo real (SSE).

> En el compositor del chat, Enter envía el mensaje y Shift+Enter inserta un salto de línea.

### Funciones listas para demo

- Comandos rápidos: si pedís directamente “mostrame mis notas”, “mostrame los leads” o “mostrame los follow-ups completados”, el agente invoca la tool correspondiente sin depender del LLM (mejora resiliencia ante JSON inválido).
- Gestión de follow-ups: `schedule_followup`, `list_followups` y `complete_followup` permiten mostrar un flujo end-to-end de planificación y cierre de tareas comerciales.
- Operaciones sobre notas: además de registrar, ahora se pueden listar y eliminar notas sin salir del chat.

## Scripts útiles

* **Buscar chunks** por CLI (usa el mismo pipeline RAG):

```bash
npm run search -- "mi consulta"
```

* **Re-ingestar** documentación:

```bash
npm run ingest
```

## Estructura relevante

```
frontend/
  src/app/page.tsx            # UI del chat + stream SSE
  src/app/api/chat/route.ts   # Endpoint orquestador del agente
  src/lib/agent.ts            # Planificador + loop del agente
  src/lib/tools.ts            # Tools (DB, RAG)
  src/lib/rag.ts              # Búsqueda vectorial
  src/lib/embeddings.ts       # Embeddings via Ollama
  scripts/ingest.ts           # Indexa /data a Postgres
  scripts/search.ts           # Consulta vectorial por CLI
server/db/init.sql            # Esquema + seeds
data/                         # Markdown fuente para RAG
```

## Performance (pgvector)

Crear índice e incrementar probes:

```bash
docker exec laburen_db psql -U app -d laburen_ai_agent -c \
"CREATE INDEX IF NOT EXISTS doc_chunk_embedding_idx
 ON doc_chunk USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);"

docker exec laburen_db psql -U app -d laburen_ai_agent -c \
"SET ivfflat.probes=10;"
```

## Notas de implementación

* **Cargas de entorno**: los scripts (`ingest.ts`, `search.ts`) cargan `.env` **antes** de importar módulos que dependen de `env.ts`.
* **Tipado estricto**: consultas castean `numeric → float8` e IDs a `int` para evitar `any` y strings numéricos.
* **Next.js**: no importes módulos server-only en componentes cliente. Expone operaciones de RAG vía rutas API.
* **tsconfig**: usar `moduleResolution: "Bundler"` y `verbatimModuleSyntax: true` para compatibilidad con Next/tsx.

## Solución de problemas

* **PowerShell**: no copies el prompt `PS ...>`. Variables se setean con `$env:VAR="valor"`.
* **`.env` no se aplica en CLI**: lanzar con `node -r dotenv/config` o asegurarte de cargar `.env` antes de `import(...)`.
* **Embeddings vacíos**: verificar que Ollama esté activo y que exista el modelo `nomic-embed-text`.
* **Conexión a DB**: test rápido

```bash
docker exec laburen_db psql -U app -d laburen_ai_agent -c "SELECT COUNT(*) FROM doc_chunk;"
```

---

Licencia: solo uso demostrativo para el challenge.