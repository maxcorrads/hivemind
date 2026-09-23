import type { DatabaseSync } from "node:sqlite";
import { columns, hasColumn, hasTable } from "./schema.ts";

// Baseline migrations for the feature stores, in the order their constructors used
// to create them at startup. Like the core baseline they must stay idempotent.

/** Explicit seen-message receipts complement, but never reinterpret, legacy reads. */
export function readReceipts(db: DatabaseSync): void {
  db.exec(`
        CREATE TABLE IF NOT EXISTS message_reads (
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          PRIMARY KEY (agent_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS message_reads_message ON message_reads(message_id);
        CREATE TABLE IF NOT EXISTS ui_read_revision (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          revision INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO ui_read_revision (singleton, revision) VALUES (1, 0);
      `);
  // INSERT OR IGNORE retries do not fire INSERT triggers. All changes and
  // their revision are committed/rolled back together by SQLite.
  for (const [table, events] of [
    ["message_reads", ["INSERT", "DELETE"]],
    ["reads", ["INSERT", "UPDATE", "DELETE"]],
    ["messages", ["DELETE"]],
    ["channels", ["DELETE"]],
    ["projects", ["DELETE"]],
  ] as const) {
    for (const event of events) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ui_read_${table}_${event.toLowerCase()}
            AFTER ${event} ON ${table} BEGIN
              UPDATE ui_read_revision SET revision = revision + 1 WHERE singleton = 1;
            END;`);
    }
  }
}

export function sendRequests(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS send_requests (
      actor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, PRIMARY KEY(actor_id, project_id, request_id));
      CREATE INDEX IF NOT EXISTS send_request_expiry ON send_requests(expires_at);
      CREATE INDEX IF NOT EXISTS send_actor_expiry ON send_requests(actor_id,expires_at);`);
}

/** Attachment usage counter (maintained by triggers) and upload reservations. */
export function uploadBudget(db: DatabaseSync): void {
  db.exec(`
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
  if (!db.prepare("SELECT 1 FROM upload_usage WHERE singleton = 1").get()) {
    db.exec("INSERT INTO upload_usage SELECT 1, COALESCE(SUM(bytes),0) FROM attachments");
  }
}

/** Agent credentials were removed in #144; drop the table left by older hives. */
export function dropAgentCredentials(db: DatabaseSync): void {
  db.exec("DROP TABLE IF EXISTS agent_credentials");
}

export function taskRecords(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS task_records (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, worker_id TEXT NOT NULL,
      dispatch_seq INTEGER NOT NULL, received_at INTEGER, snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_dispatch ON task_records(worker_id, dispatch_seq);
      CREATE INDEX IF NOT EXISTS task_channel ON task_records(channel_id);
      CREATE INDEX IF NOT EXISTS task_worker_handoff ON task_records(worker_id, id) WHERE json_extract(snapshot, '$.state') != 'accepted_complete';
      CREATE INDEX IF NOT EXISTS task_assigner_handoff ON task_records(json_extract(snapshot, '$.assignerId'), id) WHERE json_extract(snapshot, '$.state') != 'accepted_complete';
      CREATE TABLE IF NOT EXISTS task_events (
        message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, envelope TEXT NOT NULL,
        UNIQUE(actor_id, request_id));
      CREATE INDEX IF NOT EXISTS task_event_task ON task_events(task_id);
      CREATE TABLE IF NOT EXISTS task_request_aliases (actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,
        PRIMARY KEY(actor_id, request_id));`);
  db.exec(`CREATE INDEX IF NOT EXISTS task_held_claims ON task_records(channel_id, id)
      WHERE json_extract(snapshot, '$.claim.state') = 'held'`);
}

export function rooms(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_events (actor_id TEXT NOT NULL, request_id TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        hash TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(actor_id, request_id));
      CREATE TABLE IF NOT EXISTS room_tasks (task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, version INTEGER NOT NULL, action_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
        status TEXT NOT NULL, UNIQUE(channel_id, action_key));
      CREATE TABLE IF NOT EXISTS room_acks (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, version INTEGER NOT NULL, PRIMARY KEY(channel_id, actor_id));
      CREATE TABLE IF NOT EXISTS source_links (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(channel_id, bot_id, id));`);
}

export function notificationSubscriptions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS notification_subscriptions (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', event_types TEXT NOT NULL,
      PRIMARY KEY(agent_id, channel_id, thread_id));`);
}

export function workerRouting(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS worker_capabilities (
      worker_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, configuration TEXT NOT NULL, card TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS capabilities_project ON worker_capabilities(project_id, worker_id);
      CREATE TABLE IF NOT EXISTS routing_outcomes (
        task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worker_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        review_revision INTEGER NOT NULL, category TEXT NOT NULL, configuration TEXT NOT NULL,
        accepted INTEGER NOT NULL, recorded_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS routing_evidence ON routing_outcomes(worker_id, category, configuration, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS routing_project_retention ON routing_outcomes(project_id, recorded_at);`);
}

export function timeline(db: DatabaseSync): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS message_provenance (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        trace_id TEXT NOT NULL,
        parent_message_id TEXT,
        cause_message_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('hive','telegram','bot')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS timeline_trace_created ON message_provenance(trace_id, created_at, message_id);
      CREATE TABLE IF NOT EXISTS timeline_deliveries (
        delivery_id TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        message_seq INTEGER NOT NULL,
        wake_reason TEXT NOT NULL,
        offered_at INTEGER NOT NULL,
        last_offered_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        attempt INTEGER NOT NULL,
        PRIMARY KEY(delivery_id, agent_id, message_seq)
      );
      CREATE INDEX IF NOT EXISTS timeline_delivery_seq ON timeline_deliveries(message_seq, offered_at);
      CREATE TRIGGER IF NOT EXISTS timeline_message_default AFTER INSERT ON messages
      BEGIN
        INSERT OR IGNORE INTO message_provenance(message_id, trace_id, parent_message_id, cause_message_id, source, created_at)
        VALUES (NEW.id, COALESCE(NEW.thread_id, NEW.id), NEW.thread_id, NULL, 'hive', NEW.created_at);
      END;
    `);
}

export function decisionRequests(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS decision_requests (
      id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,
      requester_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      UNIQUE(requester_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS decision_project_created ON decision_requests(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS decision_task_created ON decision_requests(task_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_mutations (
      actor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      decision_id TEXT NOT NULL REFERENCES decision_requests(id) ON DELETE CASCADE,
      request_hash TEXT NOT NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      PRIMARY KEY(actor_id, request_id)
    );`);
}

// A (channel, brain) has at most one current execution; older ones stay as non-current rows while they drain.
const EXECUTIONS_SCHEMA = `CREATE TABLE adaptive_topology_executions (
  execution_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, brain_id TEXT NOT NULL, project_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL, snapshot TEXT NOT NULL, current INTEGER NOT NULL DEFAULT 1)`;

/**
 * Phase 2 keyed executions and locks by channel alone, phase 3 executions by (channel, brain). Executions are now
 * keyed by execution_id so a replaced request can drain beside its successor; every migrated row stays current.
 */
export function adaptiveExecutionKeys(db: DatabaseSync): void {
  const keys = (table: string) => columns(db, table).filter(column => column.pk > 0).map(column => column.name);
  const executions = keys("adaptive_topology_executions"), locks = keys("adaptive_topology_locks");
  const legacy = (names: string[]) => names.length === 1 && names[0] === "channel_id";
  const rekey = executions.length > 0 && !(executions.length === 1 && executions[0] === "execution_id");
  if (!rekey && !legacy(locks)) return;
  // The deletion trigger names these tables; the next migration recreates it.
  db.exec("DROP TRIGGER IF EXISTS adaptive_channel_deleted");
  if (rekey) db.exec(`ALTER TABLE adaptive_topology_executions RENAME TO adaptive_topology_executions_old;
      ${EXECUTIONS_SCHEMA};
      INSERT INTO adaptive_topology_executions(execution_id,channel_id,brain_id,project_id,root_message_id,snapshot,current)
        SELECT execution_id,channel_id,brain_id,project_id,root_message_id,snapshot,1 FROM adaptive_topology_executions_old ORDER BY rowid;
      DROP TABLE adaptive_topology_executions_old;`);
  if (legacy(locks)) db.exec(`ALTER TABLE adaptive_topology_locks RENAME TO adaptive_topology_locks_v1;
      CREATE TABLE adaptive_topology_locks (channel_id TEXT NOT NULL, brain_id TEXT NOT NULL,
        topology TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(channel_id,brain_id));
      INSERT INTO adaptive_topology_locks(channel_id,brain_id,topology,updated_at)
        SELECT channel_id,brain_id,topology,updated_at FROM (SELECT l.channel_id,l.topology,l.updated_at,
          COALESCE((SELECT e.brain_id FROM adaptive_topology_executions e WHERE e.channel_id=l.channel_id LIMIT 1),
            (SELECT cm.agent_id FROM channel_members cm JOIN agents a ON a.id=cm.agent_id
              WHERE cm.channel_id=l.channel_id AND a.role='brain' LIMIT 1)) AS brain_id
          FROM adaptive_topology_locks_v1 l) WHERE brain_id IS NOT NULL;
      DROP TABLE adaptive_topology_locks_v1;`);
}

export function adaptiveTopology(db: DatabaseSync): void {
  db.exec(`${EXECUTIONS_SCHEMA.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")};
      CREATE UNIQUE INDEX IF NOT EXISTS idx_adaptive_topology_current ON adaptive_topology_executions(channel_id,brain_id) WHERE current=1;
      CREATE INDEX IF NOT EXISTS idx_adaptive_topology_brain ON adaptive_topology_executions(brain_id,project_id);
      CREATE INDEX IF NOT EXISTS idx_adaptive_topology_root ON adaptive_topology_executions(root_message_id);
      CREATE TABLE IF NOT EXISTS adaptive_topology_events (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        project_id TEXT NOT NULL, created_at INTEGER NOT NULL, snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_adaptive_topology_events_channel ON adaptive_topology_events(channel_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS adaptive_topology_locks (channel_id TEXT NOT NULL, brain_id TEXT NOT NULL,
        topology TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(channel_id,brain_id));
      CREATE TABLE IF NOT EXISTS adaptive_topology_tasks (
        task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE, execution_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_adaptive_topology_tasks_execution ON adaptive_topology_tasks(execution_id);
      CREATE TABLE IF NOT EXISTS adaptive_topology_evaluated (execution_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(execution_id,event_id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS adaptive_topology_messages (
    root_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL, project_id TEXT NOT NULL,
    PRIMARY KEY(root_id,worker_id));
    CREATE INDEX IF NOT EXISTS idx_adaptive_message_execution ON adaptive_topology_messages(execution_id);
    CREATE INDEX IF NOT EXISTS idx_adaptive_message_worker ON adaptive_topology_messages(worker_id);
  `);
  // Cleanup is transactionally tied to channel/project deletion, not a best-effort UI callback.
  db.exec(`CREATE TRIGGER IF NOT EXISTS adaptive_channel_deleted AFTER DELETE ON channels BEGIN
      DELETE FROM adaptive_topology_evaluated WHERE execution_id IN
        (SELECT execution_id FROM adaptive_topology_executions WHERE channel_id=OLD.id);
      DELETE FROM adaptive_topology_events WHERE channel_id=OLD.id;
      DELETE FROM adaptive_topology_locks WHERE channel_id=OLD.id;
      DELETE FROM adaptive_topology_executions WHERE channel_id=OLD.id;
    END;`);
}

/** Durable inbox receipt ledger. */
export function inboxDelivery(db: DatabaseSync): void {
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
      CREATE INDEX IF NOT EXISTS inbox_agent_receipts ON inbox_deliveries(agent_id, acknowledged_at);
      CREATE TABLE IF NOT EXISTS inbox_early_receipts (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        PRIMARY KEY(agent_id, seq)
      );
    `);
}

/** A split delivery supersedes the oversized one; only one live delivery per agent. */
export function inboxSupersededBy(db: DatabaseSync): void {
  if (!hasColumn(db, "inbox_deliveries", "superseded_by")) {
    db.exec(`ALTER TABLE inbox_deliveries ADD COLUMN superseded_by TEXT;
          DROP INDEX IF EXISTS inbox_one_pending;`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS inbox_one_pending
        ON inbox_deliveries(agent_id) WHERE acknowledged_at IS NULL AND superseded_by IS NULL;`);
}

/**
 * The table is also the backfill marker: it is created and backfilled atomically,
 * so a failed upgrade retries and later runs never scan the ledger again.
 */
export function inboxReceiptTotals(db: DatabaseSync): void {
  if (hasTable(db, "inbox_receipt_totals")) return;
  db.exec(`
        CREATE TABLE inbox_receipt_totals (
          agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
          acknowledged_messages INTEGER NOT NULL,
          last_acknowledged_at INTEGER NOT NULL
        );
        INSERT INTO inbox_receipt_totals(agent_id, acknowledged_messages, last_acknowledged_at)
          SELECT agent_id, SUM(json_array_length(seqs)), MAX(acknowledged_at)
          FROM inbox_deliveries WHERE acknowledged_at IS NOT NULL GROUP BY agent_id;
      `);
}

/** Adaptive evidence and the Jev call history (previously created lazily on first use). */
export function adaptiveObservations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS adaptive_evidence_runs (
      execution_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS adaptive_evidence_channel ON adaptive_evidence_runs(channel_id);
      CREATE TABLE IF NOT EXISTS adaptive_evidence_attempts (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES adaptive_evidence_runs(execution_id) ON DELETE CASCADE,
      snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS adaptive_evidence_execution ON adaptive_evidence_attempts(execution_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS jev_calls (
      id TEXT PRIMARY KEY, route_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      execution_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      summary TEXT NOT NULL, sent TEXT, received TEXT, outcome TEXT);
      CREATE INDEX IF NOT EXISTS idx_jev_calls_project ON jev_calls(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jev_calls_execution ON jev_calls(execution_id, created_at);`);
}
