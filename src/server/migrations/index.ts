import { DatabaseSync } from "node:sqlite";
import { Storage } from "../storage.ts";
import * as core from "./baseline-core.ts";
import * as features from "./baseline-features.ts";
import * as telegram from "./baseline-telegram.ts";
import { agentTombstones } from "./agent-tombstones.ts";
import { dropDecisionRequests } from "./drop-decision-requests.ts";
import { jevAdvisory } from "./jev-advisory.ts";
import { performanceRetention } from "./performance-retention.ts";
import { schemaShape, validateCoreStorage, validateSchema, type SchemaShape } from "./validate.ts";

/**
 * Versioned SQLite migrations: the single source of the hive schema.
 *
 * `PRAGMA user_version` records the last applied migration. Each pending
 * migration runs in its own IMMEDIATE transaction together with the version bump,
 * so a crash leaves the database at the previous version and the step is retried.
 *
 * Versions 0 and 2 predate this runner (0: unversioned; 2: the project-storage
 * schema of #56, formerly `STORAGE_VERSION`). A legacy database can be in any
 * historical state, so it runs the whole baseline (versions 3–26), whose steps
 * are idempotent and detect what is already there. Migrations after the baseline
 * run exactly once and may assume the baseline schema.
 *
 * To change the schema, append a migration with the next version. Never edit or
 * reorder a shipped migration.
 */
export type Migration = { version: number; name: string; up(db: DatabaseSync): void };

export const LEGACY_VERSIONS: readonly number[] = [0, 2];
/** The version marker older releases wrote for the project-storage schema. */
export const LEGACY_PROJECT_STORAGE_VERSION = 2;

export const MIGRATIONS: readonly Migration[] = [
  { version: 3, name: "core_tables", up: core.coreTables },
  { version: 4, name: "message_event_type", up: core.messageEventType },
  { version: 5, name: "bot_credentials", up: core.botCredentials },
  { version: 6, name: "message_recipients", up: core.messageRecipients },
  { version: 7, name: "project_storage", up: core.projectStorage },
  { version: 8, name: "project_query_indexes", up: core.projectQueryIndexes },
  { version: 9, name: "telegram_outbox_destinations", up: telegram.telegramOutboxDestinations },
  { version: 10, name: "telegram_update_failures", up: telegram.telegramUpdateFailures },
  { version: 11, name: "read_receipts", up: features.readReceipts },
  { version: 12, name: "send_requests", up: features.sendRequests },
  { version: 13, name: "upload_budget", up: features.uploadBudget },
  { version: 14, name: "drop_agent_credentials", up: features.dropAgentCredentials },
  { version: 15, name: "task_records", up: features.taskRecords },
  { version: 16, name: "rooms", up: features.rooms },
  { version: 17, name: "notification_subscriptions", up: features.notificationSubscriptions },
  { version: 18, name: "worker_routing", up: features.workerRouting },
  { version: 19, name: "timeline", up: features.timeline },
  { version: 20, name: "decision_requests", up: features.decisionRequests },
  { version: 21, name: "adaptive_execution_keys", up: features.adaptiveExecutionKeys },
  { version: 22, name: "adaptive_topology", up: features.adaptiveTopology },
  { version: 23, name: "inbox_delivery", up: features.inboxDelivery },
  { version: 24, name: "inbox_superseded_by", up: features.inboxSupersededBy },
  { version: 25, name: "inbox_receipt_totals", up: features.inboxReceiptTotals },
  { version: 26, name: "adaptive_observations", up: features.adaptiveObservations },
  // After the baseline: each runs exactly once (a legacy database runs it after the whole baseline).
  { version: 27, name: "jev_advisory", up: jevAdvisory },
  { version: 28, name: "performance_retention", up: performanceRetention },
  { version: 29, name: "agent_tombstones", up: agentTombstones },
  { version: 30, name: "drop_decision_requests", up: dropDecisionRequests },
];

/** The last idempotent baseline migration; later migrations may assume its schema. */
export const BASELINE_VERSION = 26;

export const LATEST_VERSION = MIGRATIONS.at(-1)!.version;

export function schemaVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function isPending(current: number, migration: Migration): boolean {
  return LEGACY_VERSIONS.includes(current) || migration.version > current;
}

/** Rejects a database this code cannot migrate, before anything writes to it. */
export function assertSupportedVersion(db: DatabaseSync): number {
  const version = schemaVersion(db);
  if (version > LATEST_VERSION) {
    throw new Error(`Unsupported storage schema version ${version}: it was written by a newer Hivemind ` +
      `(this build supports up to ${LATEST_VERSION}). Upgrade Hivemind; the database was not modified.`);
  }
  if (!LEGACY_VERSIONS.includes(version) && version < MIGRATIONS[0]!.version) {
    throw new Error(`Unsupported storage schema version ${version}`);
  }
  return version;
}

let reference: SchemaShape | undefined;

/** The schema every migration produces on an empty database (computed once per process). */
export function referenceSchema(): SchemaShape {
  if (!reference) {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, { validate: false });
      reference = schemaShape(db);
    } finally { db.close(); }
  }
  return reference;
}

export type MigrationOptions = {
  /** Stop after this version (tests use it to reproduce intermediate states). */
  target?: number;
  /** Validate the result against the reference schema (default true). */
  validate?: boolean;
};

/**
 * Brings `db` to the current schema. Run it at startup, before any store is constructed.
 * Returns the applied migrations, in order.
 */
export function applyMigrations(db: DatabaseSync, options: MigrationOptions = {}): Migration[] {
  const storage = Storage.for(db);
  const target = options.target ?? LATEST_VERSION;
  const initial = assertSupportedVersion(db);
  // A versioned but partial legacy schema must not be silently bootstrapped.
  if (initial === LEGACY_PROJECT_STORAGE_VERSION) storage.transaction(() => validateCoreStorage(db), { immediate: false });
  const applied: Migration[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version > target) break;
    if (!isPending(schemaVersion(db), migration)) continue;
    storage.transaction(() => {
      // Re-read inside the write lock: another process may have applied it meanwhile.
      if (!isPending(assertSupportedVersion(db), migration)) return;
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      applied.push(migration);
    });
  }
  if (options.validate !== false && target === LATEST_VERSION) {
    storage.transaction(() => validateSchema(db, referenceSchema()), { immediate: false });
  }
  return applied;
}

export { initTelegramRouting } from "./telegram-routing.ts";
