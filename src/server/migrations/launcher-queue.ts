import type { DatabaseSync } from "node:sqlite";

/** Durable launch intent and broker command ledger. The command payload is private to the local database. */
export function launcherQueue(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS launch_requests (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    brain_id TEXT NOT NULL REFERENCES agents(id),
    template_id TEXT REFERENCES worker_templates(id) ON DELETE SET NULL,
    template_snapshot TEXT NOT NULL,
    task_id TEXT,
    job_id TEXT,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    ticket_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('awaiting_approval','approved','launching','launched','failed','rejected','cancelled','expired')),
    reason TEXT,
    requested_at INTEGER NOT NULL,
    decided_by TEXT,
    decided_at INTEGER,
    session TEXT,
    error TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_launch_requests_state ON launch_requests(state, requested_at)");
  db.exec(`CREATE TABLE IF NOT EXISTS launcher_commands (
    id TEXT PRIMARY KEY,
    request_id TEXT REFERENCES launch_requests(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('launch','kill')),
    state TEXT NOT NULL CHECK(state IN ('queued','dispatched','done','failed','cancelled')),
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    error TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_launcher_commands_queue ON launcher_commands(state, created_at)");
}
