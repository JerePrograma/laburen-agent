// src/lib/session-store.ts
import { query, queryOne } from "@/lib/db";
import type { AgentMessage } from "@/lib/types";

export interface AgentSession {
  id: string;
  createdAt: Date;
  history: AgentMessage[];
  authenticatedUser?: { id: number; name: string } | null;
}

function clampHistory(history: AgentMessage[], max = 120) {
  return history.length > max ? history.slice(history.length - max) : history;
}

function serialize(session: AgentSession) {
  return {
    id: session.id,
    created_at: session.createdAt.toISOString(),
    authenticated_user: session.authenticatedUser ?? null,
    history: clampHistory(session.history),
  };
}

export async function getSession(id: string): Promise<AgentSession> {
  const row = await queryOne<{
    id: string;
    created_at: string;
    authenticated_user: any | null;
    history: any;
  }>(
    // UPSERT atómico + lectura en una sola query
    `
    WITH upsert AS (
      INSERT INTO session (id)
      VALUES ($1)
      ON CONFLICT (id) DO NOTHING
      RETURNING id, created_at, authenticated_user, history
    )
    SELECT id, created_at, authenticated_user, history FROM upsert
    UNION ALL
    SELECT id, created_at, authenticated_user, history
      FROM session
     WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  const hist =
    Array.isArray(row?.history) ? row!.history
    : typeof row?.history === "string" ? JSON.parse(row!.history as unknown as string)
    : [];

  return {
    id: row!.id,
    createdAt: new Date(row!.created_at),
    authenticatedUser: row!.authenticated_user ?? null,
    history: hist,
  };
}

export async function saveSession(session: AgentSession): Promise<void> {
  const s = serialize(session);
  await query(
    `UPDATE session
        SET authenticated_user = $2::jsonb,
            history = $3::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [s.id, JSON.stringify(s.authenticated_user), JSON.stringify(s.history)]
  );
}
