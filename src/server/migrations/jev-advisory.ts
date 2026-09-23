import type { DatabaseSync } from "node:sqlite";
import { hasColumn, rebuild } from "./schema.ts";

/** Execution snapshot fields that only described an enforced mode, budget, lock or drain (before #211). */
const ENFORCEMENT_FIELDS = ["currentTopology", "workerBudget", "desiredTopology", "desiredWorkers", "lockScope",
  "lockedTopology", "orchestratedOnly", "providerAvailable", "warning", "confirmations", "confirmationHighCount",
  "confirmationTopology", "confirmationWorkers", "eventsSinceChange", "supersededBy", "current", "monitoring",
  "openWork", "requestExcerpt", "evidence"];

/**
 * #211: Jev is advisory-only. Drops everything that only served enforcement: conversation locks, the task and
 * free-form delegation links used for admission, the evaluated-event ledger of the anti-flapping policy, and draining
 * (non-current) executions. Executions become one row per (channel, brain) holding the latest advice; the routing
 * audit of enforced decisions is cleared. The Jev call log (`jev_calls`) and evidence are kept.
 */
export function jevAdvisory(db: DatabaseSync): void {
  db.exec(`DROP TRIGGER IF EXISTS adaptive_channel_deleted;
    DROP TABLE IF EXISTS adaptive_topology_locks;
    DROP TABLE IF EXISTS adaptive_topology_tasks;
    DROP TABLE IF EXISTS adaptive_topology_evaluated;
    DROP TABLE IF EXISTS adaptive_topology_messages;`);
  if (hasColumn(db, "adaptive_topology_executions", "current")) {
    // Enforced audit events (transitions, locks, warnings) would read as advice: the call log keeps the history.
    db.exec(`DELETE FROM adaptive_topology_events;
      DELETE FROM adaptive_topology_executions WHERE current=0;
      DROP INDEX IF EXISTS idx_adaptive_topology_current;`);
    const paths = ENFORCEMENT_FIELDS.map(field => `'$.${field}'`).join(",");
    rebuild(db, "adaptive_topology_executions",
      `execution_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, brain_id TEXT NOT NULL, project_id TEXT NOT NULL,
        root_message_id TEXT NOT NULL, snapshot TEXT NOT NULL, UNIQUE(channel_id,brain_id)`,
      `execution_id,channel_id,brain_id,project_id,root_message_id,
        CASE WHEN json_valid(snapshot) THEN json_remove(snapshot,${paths}) ELSE snapshot END`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_adaptive_topology_brain ON adaptive_topology_executions(brain_id,project_id);
    CREATE INDEX IF NOT EXISTS idx_adaptive_topology_root ON adaptive_topology_executions(root_message_id);
    CREATE TRIGGER IF NOT EXISTS adaptive_channel_deleted AFTER DELETE ON channels BEGIN
      DELETE FROM adaptive_topology_events WHERE channel_id=OLD.id;
      DELETE FROM adaptive_topology_executions WHERE channel_id=OLD.id;
    END;`);
}
