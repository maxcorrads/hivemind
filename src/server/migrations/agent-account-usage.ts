import type { DatabaseSync } from 'node:sqlite';

/**
 * The latest quota usage of each named account (docs/accounts.md): the last good snapshot's windows, plan and capture
 * time, the last attempt and its error, and the limit errors seen. Holds provider numbers and short text, never a token
 * or a login file. Deleting an account deletes its usage.
 */
export function agentAccountUsage(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_account_usage (
    account_id TEXT PRIMARY KEY REFERENCES agent_accounts(id) ON DELETE CASCADE,
    captured_at INTEGER,
    source TEXT,
    plan TEXT NOT NULL DEFAULT 'unknown',
    windows TEXT NOT NULL DEFAULT '[]',
    last_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    limit_reset_at INTEGER,
    limit_error_at INTEGER
  );`);
}
