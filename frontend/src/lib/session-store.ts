import { query, queryOne } from "@/lib/db";
import type { AgentMessage } from "@/lib/types";

export interface AgentSession {
  id: string;
  createdAt: Date;
  history: AgentMessage[];
  authenticatedUser?: { id: number; name: string } | null;
}

function serialize(session: AgentSession) {
  return {
    id: session.id,
    created_at: session.createdAt.toISOString(),
    authenticated_user: session.authenticatedUser ?? null,
    history: session.history,
  };
}

export async function getSession(id: string): Promise<AgentSession> {
  const row = await queryOne<{
    id: string;
    created_at: string;
    authenticated_user: any | null;
    history: any;
  }>(
    `SELECT id, created_at, authenticated_user, history
     FROM session WHERE id = $1`,
    [id]
  );

  if (row) {
    return {
      id: row.id,
      createdAt: new Date(row.created_at),
      authenticatedUser: row.authenticated_user ?? null,
      history: Array.isArray(row.history) ? row.history : [],
    };
  }

  // create
  await query(
    `INSERT INTO session(id, authenticated_user, history)
     VALUES ($1, $2::jsonb, $3::jsonb)`,
    [id, null, JSON.stringify([])]
  );
  return { id, createdAt: new Date(), history: [], authenticatedUser: null };
}

export async function saveSession(session: AgentSession): Promise<void> {
  const s = serialize(session);
  await query(
    `UPDATE session
       SET authenticated_user = $2::jsonb,
           history = $3::jsonb
     WHERE id = $1`,
    [s.id, JSON.stringify(s.authenticated_user), JSON.stringify(s.history)]
  );
}
