import type { DatabaseSync } from "node:sqlite";

/**
 * The Human decision queue is removed. Its root messages and thread replies stay as ordinary chat history; only the
 * request records (options, recommendation, state and answer idempotency) are dropped.
 */
export function dropDecisionRequests(db: DatabaseSync): void {
  db.exec(`DROP TABLE IF EXISTS decision_mutations;
    DROP TABLE IF EXISTS decision_requests;`);
}
