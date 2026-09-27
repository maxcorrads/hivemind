import type { DatabaseSync } from "node:sqlite";
import { hasColumn } from "./schema.ts";

/** Human-controlled launch mode and a distinct archive tombstone for task-bound workers. */
export function brainWorkerOrchestration(db: DatabaseSync): void {
  if (!hasColumn(db, "agents", "launch_mode")) db.exec("ALTER TABLE agents ADD COLUMN launch_mode TEXT NOT NULL DEFAULT 'approval' CHECK(launch_mode IN ('approval','auto'))");
  if (!hasColumn(db, "agents", "archived_at")) db.exec("ALTER TABLE agents ADD COLUMN archived_at INTEGER");
  if (!hasColumn(db, "agents", "reserved_by_brain_id")) db.exec("ALTER TABLE agents ADD COLUMN reserved_by_brain_id TEXT REFERENCES agents(id) ON DELETE SET NULL");
  if (!hasColumn(db, "launch_requests", "request_hash")) db.exec("ALTER TABLE launch_requests ADD COLUMN request_hash TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_agents_archived ON agents(archived_at, project_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_launch_requests_agent ON launch_requests(agent_id, requested_at DESC)");
}
