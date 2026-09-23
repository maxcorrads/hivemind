import { Storage } from "./storage.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveError, type InboxDelivery, type InboxStatus } from "../shared/types.ts";

// One bounded batch per identity; scan and byte limits are enforced by InboxReader.
export const INBOX_BATCH_MAX = 100;
export const INBOX_LEASE_MS = 5 * 60_000;

type DeliveryRow = {
  id: string; agent_id: string; session_id: string; through_seq: number;
  seqs: string; attempts: number; offered_at: number; lease_until: number;
  acknowledged_at: number | null;
  superseded_by: string | null;
};

/** Durable receipt ledger; receiving mail is not accepting or completing an assignment. */
export class InboxDeliveryStore {
  constructor(private db: DatabaseSync) {}

  private transaction<T>(fn: () => T): T {
    return Storage.for(this.db).transaction(fn);
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

  /** Whether the agent was offered the message, and acknowledged it (an acknowledged delivery wins). */
  receiptState(agentId: string, seq: number): "pending" | "offered" | "acknowledged" {
    const rows = this.db.prepare(`SELECT acknowledged_at FROM inbox_deliveries d
      WHERE d.agent_id = ? AND EXISTS (SELECT 1 FROM json_each(d.seqs) WHERE CAST(value AS INTEGER) = ?)
      ORDER BY acknowledged_at IS NOT NULL DESC LIMIT 1`).all(agentId, seq) as Array<{ acknowledged_at: number | null }>;
    if (!rows.length) return "pending";
    return rows[0]!.acknowledged_at === null ? "offered" : "acknowledged";
  }

  pending(agentId: string): DeliveryRow | undefined {
    return this.db.prepare("SELECT * FROM inbox_deliveries WHERE agent_id = ? AND acknowledged_at IS NULL AND superseded_by IS NULL")
      .get(agentId) as DeliveryRow | undefined;
  }

  skipUnaddressed(agentId: string, sessionId: string, throughSeq: number) {
    this.transaction(() => {
      this.requireSession(agentId, sessionId);
      if (!this.pending(agentId)) this.db.prepare("UPDATE agents SET inbox_cursor = MAX(inbox_cursor, ?) WHERE id = ?")
        .run(throughSeq, agentId);
      this.db.prepare("DELETE FROM inbox_early_receipts WHERE agent_id = ? AND seq <= (SELECT inbox_cursor FROM agents WHERE id = ?)")
        .run(agentId, agentId);
    });
  }

  offer(agentId: string, sessionId: string, seqs: number[], throughSeq: number, expectedPendingId?: string): InboxDelivery {
    return this.transaction(() => {
      this.requireSession(agentId, sessionId);
      const old = this.pending(agentId);
      if (old?.id !== expectedPendingId) throw new HiveError(409, "HTTP 409: Pending inbox changed during selection; receive it again with wait");
      const t = Date.now();
      const reuse = old && old.through_seq === throughSeq && old.seqs === JSON.stringify(seqs);
      const id = reuse ? old.id : randomUUID();
      if (reuse) {
        // Explicit retries can replay early; neither expiry nor takeover creates a new batch.
        this.db.prepare(`UPDATE inbox_deliveries SET session_id = ?, attempts = attempts + 1,
          offered_at = ?, lease_until = ? WHERE id = ?`).run(sessionId, t, t + INBOX_LEASE_MS, id);
      } else {
        if (!seqs.length || seqs.length > INBOX_BATCH_MAX) throw new HiveError(400, "Invalid inbox batch size");
        // A pre-upgrade batch may exceed the new budget. Retire its ID atomically:
        // acknowledging the old whole batch must never consume its undelivered tail.
        if (old) this.db.prepare("UPDATE inbox_deliveries SET superseded_by = ? WHERE id = ?").run(id, old.id);
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

  acknowledge(agentId: string, sessionId: string, deliveryId: string, onReceipt?: (seqs: number[], at: number) => void) {
    return this.transaction(() => {
      this.requireSession(agentId, sessionId);
      const row = this.db.prepare("SELECT * FROM inbox_deliveries WHERE agent_id = ? AND id = ?")
        .get(agentId, deliveryId) as DeliveryRow | undefined;
      if (!row) throw new HiveError(404, "Inbox delivery not found");
      if (row.superseded_by) throw new HiveError(409, "HTTP 409: Delivery was split to fit inbox limits; receive the current batch with wait before acknowledging");
      if (row.session_id !== sessionId) throw new HiveError(409, "Delivery belongs to an older session; receive it again before acknowledging");
      if (row.acknowledged_at !== null)
        return { acknowledged: true, duplicate: true, deliveryId, acknowledgedAt: row.acknowledged_at };
      const t = Date.now();
      this.db.prepare("UPDATE agents SET inbox_cursor = MAX(inbox_cursor, ?) WHERE id = ?")
        .run(row.through_seq, agentId);
      const early = this.db.prepare("INSERT OR IGNORE INTO inbox_early_receipts(agent_id, seq) VALUES (?, ?)");
      for (const seq of JSON.parse(row.seqs) as number[]) if (seq > row.through_seq) early.run(agentId, seq);
      this.db.prepare("DELETE FROM inbox_early_receipts WHERE agent_id = ? AND seq <= (SELECT inbox_cursor FROM agents WHERE id = ?)")
        .run(agentId, agentId);
      this.db.prepare("UPDATE inbox_deliveries SET acknowledged_at = ? WHERE id = ?").run(t, row.id);
      this.db.prepare(`INSERT INTO inbox_receipt_totals(agent_id, acknowledged_messages, last_acknowledged_at)
        VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET
          acknowledged_messages = inbox_receipt_totals.acknowledged_messages + excluded.acknowledged_messages,
          last_acknowledged_at = MAX(inbox_receipt_totals.last_acknowledged_at, excluded.last_acknowledged_at)`)
        .run(agentId, (JSON.parse(row.seqs) as number[]).length, t);
      onReceipt?.(JSON.parse(row.seqs) as number[], t);
      return { acknowledged: true, duplicate: false, deliveryId, acknowledgedAt: t };
    });
  }

  status(agentId: string): InboxStatus {
    const pending = this.pending(agentId);
    const totals = this.db.prepare(`SELECT acknowledged_messages AS messages, last_acknowledged_at AS at
      FROM inbox_receipt_totals WHERE agent_id = ?`)
      .get(agentId) as { messages: number; at: number } | undefined;
    return { awaitingReceipt: pending ? JSON.parse(pending.seqs).length : 0,
      acknowledgedMessages: totals?.messages ?? 0, lastAcknowledgedAt: totals?.at ?? null };
  }
}
