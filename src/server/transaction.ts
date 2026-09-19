import type { DatabaseSync } from "node:sqlite";

/** A synchronous, top-level transaction; publish notifications only after it returns.
 * BEGIN stays outside the catch: a rejected nested transaction must not roll back
 * its caller. Do not use DatabaseSync.isTransaction (absent on Node 22.13.0).
 */
export function immediateTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); }
    catch { /* SQLite may already have rolled back; preserve the original error. */ }
    throw error;
  }
}
