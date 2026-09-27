import type { DatabaseSync } from 'node:sqlite';
import { hasColumn } from './schema.ts';

export function jobsTaskControl(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    brain_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    origin_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    title TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','paused','done','cancelled')),
    revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id,updated_at);
  CREATE TABLE IF NOT EXISTS job_events (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(actor_id,request_id)
  )`);
  if (!hasColumn(db, 'task_records', 'job_id')) db.exec('ALTER TABLE task_records ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_job ON task_records(job_id)');
  if (!hasColumn(db, 'launch_requests', 'launch_kind')) db.exec("ALTER TABLE launch_requests ADD COLUMN launch_kind TEXT NOT NULL DEFAULT 'claim' CHECK(launch_kind IN ('claim','resume'))");
}
