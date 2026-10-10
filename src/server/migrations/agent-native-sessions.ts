import type { DatabaseSync } from 'node:sqlite';

export function agentNativeSessions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_native_sessions (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    metadata TEXT NOT NULL
  )`);
}
