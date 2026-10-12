import type { DatabaseSync } from 'node:sqlite';

/**
 * The named Codex and Claude accounts (docs/accounts.md): each account's login directories, its place in its driver's
 * list, and the driver's policy. Holds paths and order only, never a token.
 */
export function agentAccounts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_accounts (
    id TEXT PRIMARY KEY,
    driver TEXT NOT NULL CHECK (driver IN ('codex','claude')),
    label TEXT NOT NULL,
    position INTEGER NOT NULL,
    home_path TEXT NOT NULL DEFAULT '',
    shadow_path TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    last_selected_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_accounts_driver_label ON agent_accounts(driver, label);
  CREATE UNIQUE INDEX IF NOT EXISTS agent_accounts_shadow ON agent_accounts(shadow_path) WHERE shadow_path <> '';
  CREATE INDEX IF NOT EXISTS agent_accounts_driver_position ON agent_accounts(driver, position);
  CREATE TABLE IF NOT EXISTS agent_account_policies (
    driver TEXT PRIMARY KEY CHECK (driver IN ('codex','claude')),
    policy TEXT NOT NULL CHECK (policy IN ('sequential','balanced')),
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );`);
}
