import type { DatabaseSync } from "node:sqlite";
import { hasColumn } from "./schema.ts";

/**
 * Reserved, task-bound workers (docs/agent-management-roadmap.md, Phase A1): a worker row can exist before its process
 * joins. `pending_until` is set while it waits for its launch to claim it with a single-use ticket (`claim_hash`, the
 * SHA-256 of the ticket); `template_id` names the worker template it was launched from. Existing agents get none.
 */
export function agentReservations(db: DatabaseSync): void {
  if (!hasColumn(db, "agents", "pending_until")) db.exec("ALTER TABLE agents ADD COLUMN pending_until INTEGER");
  if (!hasColumn(db, "agents", "claim_hash")) db.exec("ALTER TABLE agents ADD COLUMN claim_hash TEXT");
  if (!hasColumn(db, "agents", "template_id")) db.exec("ALTER TABLE agents ADD COLUMN template_id TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_claim ON agents(claim_hash) WHERE claim_hash IS NOT NULL");
}
