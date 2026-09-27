import type { DatabaseSync } from 'node:sqlite';

/** Match the Human task page's keyset and its per-worker saved launch-template lookup. */
export function taskViewIndexes(db: DatabaseSync): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_updated_page ON task_records
    (COALESCE(CAST(json_extract(snapshot,'$.updatedAt') AS INTEGER),0) DESC,id DESC)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_launch_task_worker ON launch_requests(task_id,agent_id,requested_at DESC)');
}
