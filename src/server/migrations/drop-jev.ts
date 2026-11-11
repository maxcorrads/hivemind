import type { DatabaseSync } from "node:sqlite";

/**
 * Jev advice is removed. Drops its call log, the latest advice per conversation, the routing audit and the evidence
 * runs, with the trigger that cleaned them up when a channel was deleted. Messages, tasks and rooms are untouched.
 */
export function dropJev(db: DatabaseSync): void {
  db.exec(`DROP TRIGGER IF EXISTS adaptive_channel_deleted;
    DROP TABLE IF EXISTS jev_calls;
    DROP TABLE IF EXISTS adaptive_topology_events;
    DROP TABLE IF EXISTS adaptive_topology_executions;
    DROP TABLE IF EXISTS adaptive_evidence_attempts;
    DROP TABLE IF EXISTS adaptive_evidence_runs;`);
}
