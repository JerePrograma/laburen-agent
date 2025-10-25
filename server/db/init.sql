-- Extensiones
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

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
  embedding vector(768)
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

-- Seguimientos
CREATE TABLE IF NOT EXISTS follow_up (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES invited_user(id),
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS follow_up_user_status_due_idx
  ON follow_up (user_id, status, due_at NULLS LAST, created_at DESC);

-- Sesiones persistentes
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  authenticated_user JSONB,
  history JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS session_created_at_idx ON session (created_at DESC);

-- Seeds de usuarios de ejemplo (idempotentes por passcode único)
INSERT INTO invited_user(name, passcode)
VALUES ('Seba','123456')
ON CONFLICT (passcode) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO invited_user(name, passcode)
VALUES ('Jeremías','654321')
ON CONFLICT (passcode) DO UPDATE SET name = EXCLUDED.name;
