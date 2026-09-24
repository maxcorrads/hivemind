import type { DatabaseSync } from "node:sqlite";

/**
 * The single unit of work for a SQLite connection. Every server module opens
 * transactions through `Storage.for(db).transaction(...)` (Hive exposes its own
 * as `hive.storage`); no other module issues BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
 *
 * Semantics:
 * - One Storage per DatabaseSync handle (`Storage.for` memoizes it), so every
 *   module sharing a handle also shares its transaction depth and effects.
 * - The outermost `transaction` issues BEGIN IMMEDIATE by default: writers take
 *   SQLite's RESERVED lock up front, so read-then-write sequences (claims,
 *   idempotency checks, outbox leases) cannot interleave with another process
 *   and never fail with SQLITE_BUSY on lock upgrade. Pass `{ immediate: false }`
 *   for a read-only snapshot (BEGIN DEFERRED).
 * - Nested calls open a SAVEPOINT and ignore `immediate`: the outermost call
 *   decides the lock. A nested failure rolls back only its own savepoint (and
 *   discards the effects it scheduled); the caller may catch it and continue.
 *   A failure that escapes the outermost call rolls back everything.
 * - `afterCommit(effect)` defers an effect (bus events, waking waiters) until
 *   the outermost transaction commits; outside a transaction it runs at once.
 *   Effects run in scheduling order and are infallible: the data they react to
 *   is already durable, so a failing effect is logged and the rest still run;
 *   the failure never reaches the caller whose transaction committed.
 * - `work` must be synchronous. A returned promise is rejected (and the
 *   transaction rolled back) because the transaction would end before it does.
 * - Never consults DatabaseSync.isTransaction (absent on Node 22.13.0); the
 *   depth counter is the source of truth.
 */
export type TransactionOptions = { immediate?: boolean };

export class Storage {
  private static readonly handles = new WeakMap<DatabaseSync, Storage>();

  /** The Storage that owns transactions on `db`. */
  static for(db: DatabaseSync): Storage {
    let storage = Storage.handles.get(db);
    if (!storage) {
      storage = new Storage(db);
      Storage.handles.set(db, storage);
    }
    return storage;
  }

  private depth = 0;
  private effects: Array<() => void> = [];
  /** SQLite discarded the whole transaction under a savepoint (e.g. RAISE(ROLLBACK)). */
  private aborted = false;

  private constructor(readonly db: DatabaseSync) {}

  /** True while a transaction opened through this Storage is active. */
  get active(): boolean {
    return this.depth > 0;
  }

  /** Lets SQLite refresh the planner statistics it considers stale (cheap; run periodically, never inside a transaction). */
  optimize(): void {
    if (this.depth > 0) throw new Error("PRAGMA optimize must run outside a transaction");
    this.db.exec("PRAGMA optimize");
  }

  transaction<T>(work: () => T, options: TransactionOptions = {}): T {
    const depth = this.depth;
    const savepoint = `storage_${depth}`;
    if (depth > 0 && this.aborted) throw new Error("The enclosing transaction was rolled back by SQLite");
    const effectCount = this.effects.length;
    // BEGIN stays outside the try: a rejected BEGIN must not roll back anyone else's transaction.
    this.db.exec(depth > 0 ? `SAVEPOINT ${savepoint}` : options.immediate === false ? "BEGIN DEFERRED" : "BEGIN IMMEDIATE");
    this.depth = depth + 1;
    let result: T;
    try {
      result = work();
      if (isThenable(result)) throw new Error("Storage.transaction work must be synchronous");
      this.db.exec(depth > 0 ? `RELEASE ${savepoint}` : "COMMIT");
    } catch (error) {
      this.effects.length = effectCount;
      try {
        this.db.exec(depth > 0 ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      } catch {
        // SQLite may already have rolled back; preserve the original failure (including a failed COMMIT).
        if (depth > 0) this.aborted = true;
      }
      throw error;
    } finally {
      this.depth = depth;
      if (depth === 0) this.aborted = false;
    }
    if (depth === 0) this.flush();
    return result;
  }

  /** Runs `effect` after the outermost transaction commits, or now when none is active. */
  afterCommit(effect: () => void): void {
    if (this.depth > 0) this.effects.push(effect);
    else runEffect(effect);
  }

  private flush(): void {
    for (const effect of this.effects.splice(0)) runEffect(effect);
  }
}

/** Runs a post-commit effect, logging (never rethrowing) its failure. */
export function runEffect(effect: () => void, label = "post-commit effect"): void {
  try {
    effect();
  } catch (error) {
    console.error(`hivemind ${label} failed:`, error instanceof Error ? error.message : String(error));
  }
}

function isThenable(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null &&
    typeof (value as { then?: unknown }).then === "function";
}
