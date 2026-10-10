import type { DatabaseSync } from 'node:sqlite';
import { hasColumn } from './schema.ts';

export function launchSessionFencing(db: DatabaseSync): void {
  // Do not backfill from the current session: it may have replaced the one
  // that prepared the command. Bound launches remain valid; older unbound
  // resumes fail closed and must be prepared again by Human/the task queue.
  if (!hasColumn(db, 'launch_sessions', 'previous_session_fingerprint'))
    db.exec('ALTER TABLE launch_sessions ADD COLUMN previous_session_fingerprint TEXT');
}
