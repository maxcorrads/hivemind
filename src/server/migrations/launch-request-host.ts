import type { DatabaseSync } from 'node:sqlite';
import { hasColumn } from './schema.ts';

/**
 * The remote host a launch request runs on (docs/remote-hosts.md#launch): the template's host when the request was
 * made, a host id from Server.app's catalog. NULL is this Mac, as every request before hosts.
 */
export function launchRequestHost(db: DatabaseSync): void {
  if (!hasColumn(db, 'launch_requests', 'host_id')) db.exec('ALTER TABLE launch_requests ADD COLUMN host_id TEXT');
}
