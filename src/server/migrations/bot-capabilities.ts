import type { DatabaseSync } from 'node:sqlite';

/** A data migration, not a legacy API: retained identities keep only their previous publish grant. */
export function botCapabilities(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_access (
    bot_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    capabilities TEXT NOT NULL,
    receive_channels TEXT NOT NULL,
    definition_id TEXT,
    revision INTEGER NOT NULL CHECK(revision > 0)
  );
  INSERT OR IGNORE INTO bot_access(bot_id, capabilities, receive_channels, definition_id, revision)
    SELECT id, '["publish"]', '[]', NULL, 1 FROM agents WHERE role='bot';`);
}
