import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { FILE_MAX_BYTES, HiveError } from '../shared/types.ts';
import { UPLOAD_DEADLINE_MS } from '../shared/api-contract.ts';

export type UploadLimits = { totalBytes: number; active: number; perActor: number; deadlineMs: number };
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  totalBytes: 8 * 1024 * 1024 * 1024, active: 4, perActor: 2, deadlineMs: UPLOAD_DEADLINE_MS,
};
type Host = { db: DatabaseSync; transaction<T>(work: () => T): T };
export class UploadBudget {
  readonly limits: UploadLimits;
  constructor(private readonly host: Host, limits: Partial<UploadLimits> = {}) {
    this.limits = { ...DEFAULT_UPLOAD_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || (key === 'deadlineMs' && value > UPLOAD_DEADLINE_MS))
        throw new Error('Invalid upload budget');
    }
    host.transaction(() => { host.db.exec(`
      CREATE TABLE IF NOT EXISTS upload_usage (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), bytes INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS upload_usage_insert AFTER INSERT ON attachments BEGIN
        UPDATE upload_usage SET bytes = bytes + NEW.bytes WHERE singleton = 1; END;
      CREATE TRIGGER IF NOT EXISTS upload_usage_delete AFTER DELETE ON attachments BEGIN
        UPDATE upload_usage SET bytes = bytes - OLD.bytes WHERE singleton = 1; END;
      CREATE TRIGGER IF NOT EXISTS upload_usage_change AFTER UPDATE OF bytes ON attachments BEGIN
        UPDATE upload_usage SET bytes = bytes + NEW.bytes - OLD.bytes WHERE singleton = 1; END;
      CREATE TABLE IF NOT EXISTS upload_reservations (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        bytes INTEGER NOT NULL, owner_pid INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS upload_reservations_expiry ON upload_reservations(expires_at);
      CREATE INDEX IF NOT EXISTS upload_reservations_actor ON upload_reservations(actor_id);
    `);
      if (!host.db.prepare('SELECT 1 FROM upload_usage WHERE singleton = 1').get()) {
        host.db.exec('INSERT INTO upload_usage SELECT 1, COALESCE(SUM(bytes),0) FROM attachments');
      }
    });
  }
  acquire(actorId: string, declared = FILE_MAX_BYTES) {
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > FILE_MAX_BYTES) throw new HiveError(400, 'Invalid upload size');
    const id = randomUUID(), expires = Date.now() + this.limits.deadlineMs;
    this.host.transaction(() => {
      // An expired LIVE owner still consumes its reservation. A delayed timer
      // is not permission for another process to overcommit disk or concurrency.
      const stale = this.host.db.prepare('SELECT id, owner_pid FROM upload_reservations WHERE expires_at < ? LIMIT 128').all(Date.now()) as Array<{id: string; owner_pid: number}>;
      for (const row of stale) {
        try { process.kill(row.owner_pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') this.host.db.prepare('DELETE FROM upload_reservations WHERE id = ?').run(row.id);
        }
      }
      const active = this.host.db.prepare('SELECT actor_id, bytes FROM upload_reservations').all() as Array<{ actor_id: string; bytes: number }>;
      if (active.length >= this.limits.active || active.filter(row => row.actor_id === actorId).length >= this.limits.perActor)
        throw new HiveError(429, 'Upload concurrency exhausted; retry after active uploads finish');
      const used = this.host.db.prepare('SELECT bytes FROM upload_usage WHERE singleton = 1').get() as { bytes: number };
      if (!Number.isSafeInteger(used.bytes) || used.bytes < 0) throw new HiveError(503, 'Upload quota accounting needs repair');
      if (used.bytes + active.reduce((sum, row) => sum + row.bytes, 0) + declared > this.limits.totalBytes)
        throw new HiveError(507, 'Upload storage quota exhausted; remove unused attachments before retrying');
      this.host.db.prepare('INSERT INTO upload_reservations VALUES (?, ?, ?, ?, ?)').run(id, actorId, declared, process.pid, expires);
    });
    return {
      expires,
      require: (bytes: number) => {
        const row = this.host.db.prepare('SELECT bytes, expires_at FROM upload_reservations WHERE id = ? AND actor_id = ?').get(id, actorId) as { bytes: number; expires_at: number } | undefined;
        if (!row) throw new HiveError(409, 'Upload admission no longer valid');
        if (Date.now() > row.expires_at) throw new HiveError(408, 'Upload deadline exceeded');
        if (bytes > row.bytes) throw new HiveError(413, 'Upload exceeded its declared reservation');
      },
      release: () => { this.host.db.prepare('DELETE FROM upload_reservations WHERE id = ?').run(id); },
    };
  }
}
