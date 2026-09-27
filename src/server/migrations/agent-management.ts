import type { DatabaseSync } from 'node:sqlite';
import { hasColumn } from './schema.ts';

/** Human identity edits, reserved resume aliases and a bounded operational event history. */
export function agentManagement(db: DatabaseSync): void {
  if (!hasColumn(db, 'agents', 'identity_revision'))
    db.exec('ALTER TABLE agents ADD COLUMN identity_revision INTEGER NOT NULL DEFAULT 1');
  if (!hasColumn(db, 'agents', 'seniority_overridden'))
    db.exec('ALTER TABLE agents ADD COLUMN seniority_overridden INTEGER NOT NULL DEFAULT 0 CHECK(seniority_overridden IN (0,1))');
  if (!hasColumn(db, 'agents', 'focus_overridden'))
    db.exec('ALTER TABLE agents ADD COLUMN focus_overridden INTEGER NOT NULL DEFAULT 0 CHECK(focus_overridden IN (0,1))');
  if (!hasColumn(db, 'worker_capabilities', 'last_editor_id'))
    db.exec('ALTER TABLE worker_capabilities ADD COLUMN last_editor_id TEXT REFERENCES agents(id) ON DELETE SET NULL');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_name_aliases (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_aliases_agent ON agent_name_aliases(agent_id);
  CREATE TABLE IF NOT EXISTS agent_lifecycle_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    actor_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    at INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('server','human_ui'))
  );
  CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_agent ON agent_lifecycle_events(agent_id,seq DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_at ON agent_lifecycle_events(at);`);
}
