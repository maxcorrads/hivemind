import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveError, type Message } from "../shared/types.ts";
import { requestIdSchema, SEND_RETENTION_MS, SEND_KEYS_PER_ACTOR, SEND_KEYS_TOTAL } from "../shared/mutation.ts";

/** Called INSIDE the message transaction; never publishes its own side effects. */
export class SendRequests {
  constructor(private db: DatabaseSync) {}
  run(actor: string, project: string, requestId: string, payload: unknown,
    create: () => Message, read: (id: string) => Message, now = Date.now()): Message {
    if (!requestIdSchema.safeParse(requestId).success) throw new HiveError(400, "Invalid requestId");
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const old = this.db.prepare(`SELECT payload_hash, message_id, expires_at FROM send_requests
      WHERE actor_id=? AND project_id=? AND request_id=?`).get(actor, project, requestId) as
      { payload_hash: string; message_id: string; expires_at: number } | undefined;
    if (old && old.expires_at > now) {
      if (old.payload_hash !== hash) throw new HiveError(409, "requestId already used with another payload");
      return read(old.message_id);
    }
    // Work and state have hard bounds. Never evict an unexpired promise to make room.
    this.db.prepare(`DELETE FROM send_requests WHERE rowid IN
      (SELECT rowid FROM send_requests WHERE expires_at<=? ORDER BY expires_at LIMIT 128)`).run(now);
    this.db.prepare(`DELETE FROM send_requests WHERE rowid IN
      (SELECT rowid FROM send_requests WHERE actor_id=? AND expires_at<=? ORDER BY expires_at LIMIT 128)`).run(actor, now);
    if (old) this.db.prepare('DELETE FROM send_requests WHERE actor_id=? AND project_id=? AND request_id=?')
      .run(actor, project, requestId);
    const own = Number(this.db.prepare('SELECT COUNT(*) AS n FROM send_requests WHERE actor_id=?').get(actor)!.n);
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM send_requests').get()!.n);
    if (own >= SEND_KEYS_PER_ACTOR || total >= SEND_KEYS_TOTAL)
      throw new HiveError(429, "Send idempotency storage is full; retry later with the same requestId");
    const message = create();
    this.db.prepare('INSERT INTO send_requests VALUES (?, ?, ?, ?, ?, ?)')
      .run(actor, project, requestId, hash, message.id, now + SEND_RETENTION_MS);
    return message;
  }
}
