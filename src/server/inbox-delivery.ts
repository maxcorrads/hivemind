import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveError, type InboxDelivery, type InboxStatus } from "../shared/types.ts";

// One bounded batch per identity. Aggregate scan/byte budgets are a separate change (#6).
export const INBOX_BATCH_MAX = 100;
export const INBOX_LEASE_MS = 5 * 60_000;

type DeliveryRow = {
  id: string; agent_id: string; session_id: string; through_seq: number;
  seqs: string; attempts: number; offered_at: number; lease_until: number;
  acknowledged_at: number | null;
};

/** Durable receipt ledger; receiving mail is not accepting or completing an assignment. */
export class InboxDeliveryStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_sessions (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY(agent_id, session_id), UNIQUE(agent_id, generation)
      );
      CREATE TABLE IF NOT EXISTS inbox_deliveries (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        through_seq INTEGER NOT NULL,
        seqs TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        offered_at INTEGER NOT NULL,
        lease_until INTEGER NOT NULL,
        acknowledged_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS inbox_one_pending
        ON inbox_deliveries(agent_id) WHERE acknowledged_at IS NULL;
      CREATE INDEX IF NOT EXISTS inbox_agent_receipts ON inbox_deliveries(agent_id, acknowledged_at);
    `);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  currentSession(agentId: string): string | undefined {
    return (this.db.prepare("SELECT session_id FROM inbox_sessions WHERE agent_id = ? ORDER BY generation DESC LIMIT 1")
      .get(agentId) as { session_id: string } | undefined)?.session_id;
  }

  openSession(agentId: string, sessionId: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) throw new HiveError(400, "Expected an inbox session UUID");
    return this.transaction(() => {
      const old = this.db.prepare("SELECT generation FROM inbox_sessions WHERE agent_id = ? AND session_id = ?")
        .get(agentId, sessionId);
      if (old) { this.requireSession(agentId, sessionId); return sessionId; }
      this.db.prepare(`INSERT INTO inbox_sessions(agent_id, session_id, generation)
        SELECT ?, ?, COALESCE(MAX(generation), 0) + 1 FROM inbox_sessions WHERE agent_id = ?`)
        .run(agentId, sessionId, agentId);
      return sessionId;
    });
  }

  requireSession(agentId: string, sessionId: string) {
    if (!sessionId || this.currentSession(agentId) !== sessionId)
      throw new HiveError(409, "Inbox session superseded or missing; explicitly join/open a new session");
  }

  pending(agentId: string): DeliveryRow | undefined {
    return this.db.prepare("SELECT * FROM inbox_deliveries WHERE agent_id = ? AND acknowledged_at IS NULL")
      .get(agentId) as DeliveryRow | undefined;
  }

  skipUnaddressed(agentId: string, sessionId: string, throughSeq: number) {
    this.transaction(() => {
      this.requireSession(agentId, sessionId);
      if (!this.pending(agentId)) this.db.prepare("UPDATE agents SET inbox_cursor = MAX(inbox_cursor, ?) WHERE id = ?")
        .run(throughSeq, agentId);
    });
  }

  offer(agentId: string, sessionId: string, seqs: number[], throughSeq: number): InboxDelivery {
    return this.transaction(() => {
      this.requireSession(agentId, sessionId);
      const old = this.pending(agentId);
      const t = Date.now();
      const id = old?.id ?? randomUUID();
      if (old) {
        // Explicit retries can replay early; neither expiry nor takeover creates a new batch.
        this.db.prepare(`UPDATE inbox_deliveries SET session_id = ?, attempts = attempts + 1,
          offered_at = ?, lease_until = ? WHERE id = ?`).run(sessionId, t, t + INBOX_LEASE_MS, id);
      } else {
        if (!seqs.length || seqs.length > INBOX_BATCH_MAX) throw new HiveError(400, "Invalid inbox batch size");
        this.db.prepare(`INSERT INTO inbox_deliveries
          (id, agent_id, session_id, through_seq, seqs, attempts, offered_at, lease_until)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
          .run(id, agentId, sessionId, throughSeq, JSON.stringify(seqs), t, t + INBOX_LEASE_MS);
      }
      const row = this.pending(agentId)!;
      return { id, sessionId, messageSeqs: JSON.parse(row.seqs), attempt: row.attempts,
        offeredAt: t, leaseExpiresAt: row.lease_until, redelivered: Boolean(old) };
    });
  }

  acknowledge(agentId: string, sessionId: string, deliveryId: string) {
    return this.transaction(() => {
      this.requireSession(agentId, sessionId);
      const row = this.db.prepare("SELECT * FROM inbox_deliveries WHERE agent_id = ? AND id = ?")
        .get(agentId, deliveryId) as DeliveryRow | undefined;
      if (!row) throw new HiveError(404, "Inbox delivery not found");
      if (row.session_id !== sessionId) throw new HiveError(409, "Delivery belongs to an older session; receive it again before acknowledging");
      if (row.acknowledged_at !== null)
        return { acknowledged: true, duplicate: true, deliveryId, acknowledgedAt: row.acknowledged_at };
      const t = Date.now();
      this.db.prepare("UPDATE agents SET inbox_cursor = MAX(inbox_cursor, ?) WHERE id = ?")
        .run(row.through_seq, agentId);
      this.db.prepare("UPDATE inbox_deliveries SET acknowledged_at = ? WHERE id = ?").run(t, row.id);
      return { acknowledged: true, duplicate: false, deliveryId, acknowledgedAt: t };
    });
  }

  status(agentId: string): InboxStatus {
    const pending = this.pending(agentId);
    const rows = this.db.prepare(`SELECT COUNT(*) AS batches, COALESCE(SUM(json_array_length(seqs)), 0) AS messages,
      MAX(acknowledged_at) AS at FROM inbox_deliveries WHERE agent_id = ? AND acknowledged_at IS NOT NULL`)
      .get(agentId) as { batches: number; messages: number; at: number | null };
    return { awaitingReceipt: pending ? JSON.parse(pending.seqs).length : 0,
      acknowledgedMessages: rows.messages, lastAcknowledgedAt: rows.at };
  }
}
