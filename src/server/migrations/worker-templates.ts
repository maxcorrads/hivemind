import type { DatabaseSync } from "node:sqlite";

/**
 * The workers Human allows a project's brains to launch (docs/agent-management-roadmap.md, Phase A1). `spec` is the
 * validated JSON of src/shared/worker-templates.ts; secret values are never stored, only their names in `spec`.
 */
export function workerTemplates(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS worker_templates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    revision INTEGER NOT NULL,
    spec TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project_id, slug)
  )`);
}
