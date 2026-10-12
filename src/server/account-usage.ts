import type { ZodError } from "zod";
import { HiveError } from "../shared/types.ts";
import { usageSnapshotSchema, type AccountUsage, type UsageSnapshot, type UsageWindow } from "../shared/accounts.ts";
import type { Core } from "./services/ports.ts";

type Row = {
  account_id: string; captured_at: number | null; source: UsageSnapshot["source"] | null; plan: UsageSnapshot["plan"];
  windows: string; last_attempt_at: number; last_error: string | null; limit_reset_at: number | null; limit_error_at: number | null;
};

/** A good read replaces the windows, plan and capture time, and clears the error. `limit_error_at` is kept when none is given. */
const RECORD_GOOD = `INSERT INTO agent_account_usage (account_id, captured_at, source, plan, windows, last_attempt_at, last_error, limit_error_at)
  VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  ON CONFLICT (account_id) DO UPDATE SET captured_at = excluded.captured_at, source = excluded.source, plan = excluded.plan,
    windows = excluded.windows, last_attempt_at = excluded.last_attempt_at, last_error = NULL,
    limit_error_at = COALESCE(excluded.limit_error_at, agent_account_usage.limit_error_at)`;

/** A failed read keeps the previous windows, capture time and plan, and records only the attempt and its error. */
const RECORD_ERROR = `INSERT INTO agent_account_usage (account_id, last_attempt_at, last_error, limit_error_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (account_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
    limit_error_at = COALESCE(excluded.limit_error_at, agent_account_usage.limit_error_at)`;

/** Field paths only: a snapshot's values and unknown key names are never echoed back. */
function refuse(error: ZodError): never {
  const fields = [...new Set(error.issues.map(issue => issue.path.join(".") || "body"))].slice(0, 6);
  throw new HiveError(400, `Invalid usage snapshot: ${fields.join(", ")}`);
}

/**
 * The latest quota usage of each account (docs/accounts.md, "Usage"): the last good snapshot, which the policy and the
 * Accounts sheet both read, and the last attempt with its error. Server.app posts snapshots through the launcher channel.
 */
export class AccountUsageStore {
  constructor(private readonly deps: Core) {}

  private get db() { return this.deps.storage.db; }

  private view(row: Row): AccountUsage {
    const snapshot: UsageSnapshot | null = row.captured_at === null ? null : {
      accountId: row.account_id, capturedAt: row.captured_at, source: row.source as UsageSnapshot["source"], plan: row.plan,
      windows: JSON.parse(row.windows) as UsageWindow[], error: null, limitErrorAt: row.limit_error_at,
    };
    return { accountId: row.account_id, snapshot, lastAttemptAt: row.last_attempt_at, lastError: row.last_error,
      limitResetAt: row.limit_reset_at, limitErrorAt: row.limit_error_at };
  }

  /**
   * Stores one read of one account. The attempt time is the snapshot's capture time. A snapshot with `error` keeps the
   * previous good data; `limitErrorAt`, when given, is stored and otherwise the last one is kept.
   */
  record(raw: unknown): void {
    const parsed = usageSnapshotSchema.safeParse(raw);
    if (!parsed.success) refuse(parsed.error);
    const snapshot = parsed.data;
    this.deps.storage.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM agent_accounts WHERE id = ?").get(snapshot.accountId)) throw new HiveError(404, "Account not found");
      if (snapshot.error === null) {
        this.db.prepare(RECORD_GOOD).run(snapshot.accountId, snapshot.capturedAt, snapshot.source, snapshot.plan,
          JSON.stringify(snapshot.windows), snapshot.capturedAt, snapshot.limitErrorAt);
      } else {
        this.db.prepare(RECORD_ERROR).run(snapshot.accountId, snapshot.capturedAt, snapshot.error, snapshot.limitErrorAt);
      }
      this.deps.storage.afterCommit(() => this.deps.bus.emit("accounts", {}));
    });
  }

  list(): AccountUsage[] {
    const rows = this.db.prepare("SELECT * FROM agent_account_usage ORDER BY account_id").all() as Row[];
    return rows.map(row => this.view(row));
  }

  map(): Map<string, AccountUsage> {
    return new Map(this.list().map(usage => [usage.accountId, usage]));
  }
}
