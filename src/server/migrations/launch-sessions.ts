import type { DatabaseSync } from 'node:sqlite';

export function launchSessions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS launch_sessions (
    id TEXT PRIMARY KEY,
    ticket_hash TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    expected_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    previous_launch_id TEXT,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,
    provider TEXT NOT NULL,
    session_id TEXT,
    captured INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    bound_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS launch_sessions_agent ON launch_sessions(agent_id, bound_at);
  CREATE TABLE IF NOT EXISTS agent_launch_settings (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    launch_id TEXT NOT NULL UNIQUE REFERENCES launch_sessions(id) ON DELETE CASCADE
  );`);
}
