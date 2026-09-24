import type { DatabaseSync } from "node:sqlite";

/**
 * #217: indexes for per-channel lookups, per-message inbox receipts and deduplicated upload quota.
 *
 * - `threads(channel_id)` and `room_events(channel_id, revision)` back the channel page and contract history.
 * - `inbox_receipts` keeps one row per (agent, message) that was ever offered, with the first acknowledgement
 *   time. Triggers on `inbox_deliveries` maintain it, so a receipt lookup is a primary-key read instead of a
 *   `json_each` scan of the agent's whole ledger, and it survives retention pruning of the delivery ledger.
 * - The upload quota counts each stored blob once: attachments sharing a sha256 share one file on disk.
 */
export function performanceRetention(db: DatabaseSync): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id);
    CREATE INDEX IF NOT EXISTS idx_room_events_channel_revision ON room_events(channel_id, revision);
    CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);
    CREATE TABLE IF NOT EXISTS inbox_receipts (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      acknowledged_at INTEGER,
      PRIMARY KEY(agent_id, seq)
    );
    INSERT OR IGNORE INTO inbox_receipts(agent_id, seq, acknowledged_at)
      SELECT d.agent_id, CAST(j.value AS INTEGER), MIN(d.acknowledged_at)
      FROM inbox_deliveries d JOIN agents a ON a.id = d.agent_id, json_each(d.seqs) j
      GROUP BY d.agent_id, CAST(j.value AS INTEGER);
    CREATE TRIGGER IF NOT EXISTS inbox_receipts_offer AFTER INSERT ON inbox_deliveries BEGIN
      INSERT OR IGNORE INTO inbox_receipts(agent_id, seq, acknowledged_at)
        SELECT NEW.agent_id, CAST(value AS INTEGER), NEW.acknowledged_at FROM json_each(NEW.seqs);
      UPDATE inbox_receipts SET acknowledged_at = NEW.acknowledged_at
        WHERE NEW.acknowledged_at IS NOT NULL AND agent_id = NEW.agent_id AND acknowledged_at IS NULL
          AND seq IN (SELECT CAST(value AS INTEGER) FROM json_each(NEW.seqs));
    END;
    CREATE TRIGGER IF NOT EXISTS inbox_receipts_acknowledge AFTER UPDATE OF acknowledged_at ON inbox_deliveries
      WHEN NEW.acknowledged_at IS NOT NULL BEGIN
      UPDATE inbox_receipts SET acknowledged_at = NEW.acknowledged_at
        WHERE agent_id = NEW.agent_id AND acknowledged_at IS NULL
          AND seq IN (SELECT CAST(value AS INTEGER) FROM json_each(NEW.seqs));
    END;
    DROP TRIGGER IF EXISTS upload_usage_insert;
    DROP TRIGGER IF EXISTS upload_usage_delete;
    DROP TRIGGER IF EXISTS upload_usage_change;
    CREATE TRIGGER upload_usage_insert AFTER INSERT ON attachments
      WHEN (SELECT COUNT(*) FROM attachments WHERE sha256 = NEW.sha256) = 1 BEGIN
      UPDATE upload_usage SET bytes = bytes + NEW.bytes WHERE singleton = 1;
    END;
    CREATE TRIGGER upload_usage_delete AFTER DELETE ON attachments
      WHEN NOT EXISTS (SELECT 1 FROM attachments WHERE sha256 = OLD.sha256) BEGIN
      UPDATE upload_usage SET bytes = bytes - OLD.bytes WHERE singleton = 1;
    END;
    CREATE TRIGGER upload_usage_change AFTER UPDATE OF bytes, sha256 ON attachments BEGIN
      UPDATE upload_usage SET bytes = (SELECT COALESCE(SUM(b), 0) FROM (SELECT MAX(bytes) AS b FROM attachments GROUP BY sha256))
        WHERE singleton = 1;
    END;
    UPDATE upload_usage SET bytes = (SELECT COALESCE(SUM(b), 0) FROM (SELECT MAX(bytes) AS b FROM attachments GROUP BY sha256))
      WHERE singleton = 1;`);
}
