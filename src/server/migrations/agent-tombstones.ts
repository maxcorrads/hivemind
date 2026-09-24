import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HUMAN_ID } from "../../shared/types.ts";
import { hasColumn } from "./schema.ts";

/** The constant Human token hash written before #215: the sha256 of "human-local". */
const LEGACY_HUMAN_TOKEN_HASH = createHash("sha256").update("human-local").digest("hex");

/**
 * #215: removing an agent keeps its row as a tombstone (`removed_at`), so messages, tasks, decision requests and
 * routing outcomes keep their author and no ON DELETE CASCADE fires. Agent rows are deleted only with their project,
 * together with everything the project scoped, so the cascading foreign keys are kept as they are.
 *
 * The Human row's token hash becomes random: the old constant was the hash of a well-known string.
 */
export function agentTombstones(db: DatabaseSync): void {
  if (!hasColumn(db, "agents", "removed_at")) db.exec("ALTER TABLE agents ADD COLUMN removed_at INTEGER");
  db.prepare("UPDATE agents SET token_hash = lower(hex(randomblob(32))) WHERE id = ? AND token_hash = ?")
    .run(HUMAN_ID, LEGACY_HUMAN_TOKEN_HASH);
}
