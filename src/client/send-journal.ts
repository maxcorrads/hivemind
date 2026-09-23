import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SEND_RETENTION_MS } from "../shared/mutation.ts";
import { Storage } from "../server/storage.ts";

export const LOCAL_SEND_LIMIT = 10_000;
const idsSchema = z.array(z.string().uuid()).max(4);
type Row = { hash: string; ids: string; created: number; owner: number | null; nonce: string | null };
function ownerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** A short SQLite claim survives crashes without holding a transaction over I/O.
 * The journal contains hashes/attachment IDs, never tokens or message bodies.
 * This is same-OS-user persistence, not a boundary against that user's processes.
 */
export class SendJournal {
  readonly db: DatabaseSync;
  constructor(home: string) {
    const dir = path.join(home, "pending-sends");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "journal.sqlite");
    try { closeSync(openSync(file, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(file);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077)))
      throw new Error("Send journal must be a private regular file; inspect its permissions");
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA busy_timeout=2000;
        CREATE TABLE IF NOT EXISTS sends (
          scope TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, ids TEXT NOT NULL,
          created INTEGER NOT NULL, owner INTEGER, nonce TEXT,
          PRIMARY KEY(scope,key));
        CREATE INDEX IF NOT EXISTS send_created ON sends(created);`);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  claim(scope: string, key: string, hash: string, ids: string[], now = Date.now()): { nonce: string; ids: string[] } {
    idsSchema.parse(ids);
    return Storage.for(this.db).transaction(() => {
      const row = this.db.prepare("SELECT * FROM sends WHERE scope=? AND key=?").get(scope, key) as Row | undefined;
      if (row && row.hash !== hash) throw new Error("requestId belongs to another local payload");
      if (row && now - row.created >= SEND_RETENTION_MS) throw new Error("Outside the retry window; inspect history before a new operation");
      if (row?.owner && ownerAlive(row.owner)) throw new Error("This requestId is in progress; retry the same operation after it finishes");
      const saved = row ? idsSchema.parse(JSON.parse(row.ids)) : ids;
      if (!row) {
        // Bounded incremental cleanup. A live process's claim is never reclaimed.
        const expired = this.db.prepare("SELECT scope,key,owner FROM sends WHERE created<=? ORDER BY created LIMIT 128")
          .all(now - SEND_RETENTION_MS) as Array<{ scope: string; key: string; owner: number | null }>;
        for (const old of expired) if (!old.owner || !ownerAlive(old.owner))
          this.db.prepare("DELETE FROM sends WHERE scope=? AND key=?").run(old.scope, old.key);
        if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM sends").get()!.n) >= LOCAL_SEND_LIMIT)
          throw new Error("Local send journal is full; retain pending request IDs and retry later");
      }
      const nonce = randomUUID();
      this.db.prepare(`INSERT INTO sends VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(scope,key) DO UPDATE SET owner=excluded.owner, nonce=excluded.nonce`)
        .run(scope, key, hash, JSON.stringify(saved), now, process.pid, nonce);
      return { nonce, ids: saved };
    });
  }
  uploaded(scope: string, key: string, nonce: string, ids: string[]) {
    idsSchema.parse(ids);
    const result = this.db.prepare("UPDATE sends SET ids=? WHERE scope=? AND key=? AND owner=? AND nonce=?")
      .run(JSON.stringify(ids), scope, key, process.pid, nonce);
    if (result.changes !== 1) throw new Error("Local send claim changed; retain the original requestId");
  }
  release(scope: string, key: string, nonce: string) {
    this.db.prepare("UPDATE sends SET owner=NULL,nonce=NULL WHERE scope=? AND key=? AND owner=? AND nonce=?")
      .run(scope, key, process.pid, nonce);
  }
}
