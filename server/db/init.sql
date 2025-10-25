-- Extensión
CREATE EXTENSION IF NOT EXISTS vector;

-- Auth por chat
CREATE TABLE IF NOT EXISTS invited_user (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  passcode TEXT NOT NULL UNIQUE
);

-- RAG: docs y chunks (coseno, 768d por nomic-embed-text)
CREATE TABLE IF NOT EXISTS doc (
  id SERIAL PRIMARY KEY,
  path TEXT NOT NULL,
  meta JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS doc_chunk (
  id SERIAL PRIMARY KEY,
  doc_id INT REFERENCES doc(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(768)  -- mantener en sync con EMBEDDING_DIM
);

CREATE INDEX IF NOT EXISTS doc_chunk_embedding_hnsw
  ON doc_chunk USING hnsw (embedding vector_cosine_ops);

-- Leads
CREATE TABLE IF NOT EXISTS lead (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Notas
CREATE TABLE IF NOT EXISTS note (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES invited_user(id),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Sesiones persistentes
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  authenticated_user JSONB,     -- { "id": int, "name": text } | null
  history JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS session_created_at_idx ON session (created_at DESC);
