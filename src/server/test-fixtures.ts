// Test-only fixtures API: seeding, inspection, fault injection and time/presence
// helpers for tests that need to reach below the public Hive API.
//
// Tests should use these helpers instead of calling `.db.prepare(...)` or
// `.db.exec(...)` directly, so schema or storage refactors only need to update
// this module. Production code must never import this file.
// See src/server/test-sql-budget.unit.test.ts for the enforced raw-SQL budget.
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { Storage } from "./storage.ts";

/** Anything that owns a SQLite handle: a Hive, a store, or the database itself. */
export type DbOwner = DatabaseSync | { db: DatabaseSync };
export type Row = Record<string, SQLOutputValue>;
/** Column equality filter; `null` matches `IS NULL`. */
export type Where = Record<string, SQLInputValue>;
export type Values = Record<string, SQLInputValue>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function dbOf(owner: DbOwner): DatabaseSync {
  return owner instanceof DatabaseSync ? owner : owner.db;
}

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid SQL identifier in test fixture: ${name}`);
  return name;
}

function whereClause(where: Where = {}): { sql: string; args: SQLInputValue[] } {
  const keys = Object.keys(where);
  if (!keys.length) return { sql: "", args: [] };
  const args: SQLInputValue[] = [];
  const parts = keys.map(key => {
    const value = where[key];
    if (value === null) return `${ident(key)} IS NULL`;
    args.push(value);
    return `${ident(key)} = ?`;
  });
  return { sql: ` WHERE ${parts.join(" AND ")}`, args };
}

function columnList(columns: string | readonly string[]): string {
  return columns === "*" ? "*" : (typeof columns === "string" ? [columns] : columns).map(ident).join(", ");
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/** Number of rows in `table`, optionally restricted by column equality. */
export function countRows(owner: DbOwner, table: string, where?: Where): number {
  const clause = whereClause(where);
  const row = dbOf(owner).prepare(`SELECT COUNT(*) AS n FROM ${ident(table)}${clause.sql}`).get(...clause.args);
  return Number(row!.n);
}

/** Row counts for several tables at once (e.g. to prove an operation wrote nothing). */
export function countTables(owner: DbOwner, tables: readonly string[]): Record<string, number> {
  return Object.fromEntries(tables.map(table => [table, countRows(owner, table)]));
}

export function hasRow(owner: DbOwner, table: string, where?: Where): boolean {
  const clause = whereClause(where);
  return dbOf(owner).prepare(`SELECT 1 FROM ${ident(table)}${clause.sql} LIMIT 1`).get(...clause.args) !== undefined;
}

/** First matching row (by rowid when no order is given), or undefined. */
export function findRow(owner: DbOwner, table: string, where?: Where, columns: string | readonly string[] = "*"): Row | undefined {
  const clause = whereClause(where);
  return dbOf(owner).prepare(`SELECT ${columnList(columns)} FROM ${ident(table)}${clause.sql} LIMIT 1`).get(...clause.args);
}

/** Single column value of the first matching row. */
export function readValue(owner: DbOwner, table: string, column: string, where?: Where): SQLOutputValue | undefined {
  return findRow(owner, table, where, column)?.[column];
}

export interface ListOptions {
  where?: Where;
  columns?: string | readonly string[];
  /** Column names to order by (ascending); defaults to rowid order. */
  orderBy?: string | readonly string[];
}

export function listRows(owner: DbOwner, table: string, options: ListOptions = {}): Row[] {
  const clause = whereClause(options.where);
  const order = options.orderBy === undefined ? "" : ` ORDER BY ${columnList(options.orderBy)}`;
  return dbOf(owner).prepare(`SELECT ${columnList(options.columns ?? "*")} FROM ${ident(table)}${clause.sql}${order}`)
    .all(...clause.args).map(row => ({ ...row }));
}

/** Every row of every listed table, for before/after atomicity comparisons. */
export function snapshotTables(owner: DbOwner, tables: readonly string[]): Record<string, Row[]> {
  return Object.fromEntries(tables.map(table => [table, listRows(owner, table)]));
}

/** Rows whose text column contains `fragment` (LIKE '%fragment%'). */
export function rowsContaining(owner: DbOwner, table: string, column: string, fragment: string, columns: string | readonly string[] = "*"): Row[] {
  return dbOf(owner).prepare(`SELECT ${columnList(columns)} FROM ${ident(table)} WHERE ${ident(column)} LIKE ? ORDER BY rowid`)
    .all(`%${fragment}%`).map(row => ({ ...row }));
}

/** Parsed JSON `snapshot` column of a stored task or topology execution. */
export function storedSnapshot<T = Record<string, unknown>>(owner: DbOwner, table: "task_records" | "adaptive_topology_executions", id: string): T {
  const key = table === "task_records" ? "id" : "execution_id";
  const value = readValue(owner, table, "snapshot", { [key]: id });
  if (value === undefined) throw new Error(`No ${table} row for ${id}`);
  return JSON.parse(String(value)) as T;
}

/** The persisted inbox cursor of an agent. */
export function inboxCursor(owner: DbOwner, agentId: string): number {
  return Number(readValue(owner, "agents", "inbox_cursor", { id: agentId }));
}

/** The Telegram inbound polling offset, or undefined when never stored. */
export function telegramOffset(owner: DbOwner): string | undefined {
  const value = readValue(owner, "telegram_bot_state", "value", { key: "offset" });
  return value === undefined ? undefined : String(value);
}

// ---------------------------------------------------------------------------
// Seeding and direct mutation
// ---------------------------------------------------------------------------

/** Runs `fn` inside one explicit transaction, rolling back on failure. */
export function inTransaction<T>(owner: DbOwner, fn: () => T): T {
  // The production unit of work: nested helpers become savepoints of the caller's transaction.
  return Storage.for(dbOf(owner)).transaction(fn);
}

const insertStatements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** Inserts one row and returns its rowid. Statements are cached so bulk seeding stays fast. */
export function insertRow(owner: DbOwner, table: string, values: Values): number {
  const db = dbOf(owner);
  const keys = Object.keys(values);
  const sql = `INSERT INTO ${ident(table)} (${keys.map(ident).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  let cache = insertStatements.get(db);
  if (!cache) insertStatements.set(db, cache = new Map());
  let statement = cache.get(sql);
  if (!statement) cache.set(sql, statement = db.prepare(sql));
  const result = statement.run(...keys.map(key => values[key]));
  return Number(result.lastInsertRowid);
}

/** Inserts many rows in one transaction and returns their rowids. */
export function insertRows(owner: DbOwner, table: string, rows: Iterable<Values>): number[] {
  return inTransaction(owner, () => Array.from(rows, row => insertRow(owner, table, row)));
}

/** Updates matching rows (all rows when `where` is empty) and returns the change count. */
export function updateRows(owner: DbOwner, table: string, set: Values, where: Where = {}): number {
  const keys = Object.keys(set);
  const clause = whereClause(where);
  const result = dbOf(owner).prepare(`UPDATE ${ident(table)} SET ${keys.map(key => `${ident(key)} = ?`).join(", ")}${clause.sql}`)
    .run(...keys.map(key => set[key]), ...clause.args);
  return Number(result.changes);
}

/** Deletes matching rows (all rows when `where` is empty) and returns the change count. */
export function deleteRows(owner: DbOwner, table: string, where: Where = {}): number {
  const clause = whereClause(where);
  return Number(dbOf(owner).prepare(`DELETE FROM ${ident(table)}${clause.sql}`).run(...clause.args).changes);
}

export interface MessageSeed {
  id?: string;
  channelId: string;
  authorId: string;
  body: string;
  threadId?: string | null;
  kind?: string;
  control?: string | null;
  mentions?: readonly string[];
  createdAt?: number;
}

/** Inserts raw message rows (bypassing routing and notifications) and returns their seqs. */
export function seedMessages(owner: DbOwner, messages: Iterable<MessageSeed>): number[] {
  return insertRows(owner, "messages", Array.from(messages, message => {
    const row: Values = {
      id: message.id ?? crypto.randomUUID(), channel_id: message.channelId, author_id: message.authorId,
      body: message.body, created_at: message.createdAt ?? Date.now(),
    };
    if (message.threadId !== undefined) row.thread_id = message.threadId;
    if (message.kind !== undefined) row.kind = message.kind;
    if (message.control !== undefined) row.control = message.control;
    if (message.mentions !== undefined) row.mentions = JSON.stringify(message.mentions);
    return row;
  }));
}

export interface ChannelSeed {
  id?: string;
  name: string;
  projectId: string;
  createdBy: string;
  type?: string;
  members?: readonly string[];
}

/** Inserts raw channels with their memberships in one transaction and returns their ids. */
export function seedChannels(owner: DbOwner, channels: Iterable<ChannelSeed>): string[] {
  return inTransaction(owner, () => Array.from(channels, channel => {
    const id = channel.id ?? crypto.randomUUID();
    insertRow(owner, "channels", {
      id, name: channel.name, type: channel.type ?? "private", created_by: channel.createdBy,
      created_at: Date.now(), project_id: channel.projectId,
    });
    for (const agentId of channel.members ?? []) addChannelMember(owner, id, agentId);
    return id;
  }));
}

export function addChannelMember(owner: DbOwner, channelId: string, agentId: string): void {
  insertRow(owner, "channel_members", { channel_id: channelId, agent_id: agentId });
}

/** Removes a membership row directly, without the leave/kick side effects. */
export function removeChannelMember(owner: DbOwner, channelId: string, agentId: string): void {
  deleteRows(owner, "channel_members", { channel_id: channelId, agent_id: agentId });
}

/** Clones an agent row under new ids (same credentials/role), e.g. to fabricate many peers. */
export function cloneAgent(owner: DbOwner, sourceId: string, ids: readonly string[], overrides: (id: string) => Values = id => ({ name: id })): void {
  const source = findRow(owner, "agents", { id: sourceId });
  if (!source) throw new Error(`No agent ${sourceId}`);
  insertRows(owner, "agents", ids.map(id => ({ ...(source as Values), id, ...overrides(id) })));
}

/** Marks the whole current backlog as read for one agent, or for every agent. */
export function markInboxRead(owner: DbOwner, agentId?: string): void {
  const db = dbOf(owner);
  if (agentId === undefined) db.prepare("UPDATE agents SET inbox_cursor = (SELECT MAX(seq) FROM messages)").run();
  else db.prepare("UPDATE agents SET inbox_cursor = (SELECT MAX(seq) FROM messages) WHERE id = ?").run(agentId);
}

/**
 * Simulates a pre-counter hive with `size` acknowledged deliveries for an agent:
 * drops the receipt totals table and back-fills the delivery ledger.
 * Callers construct a new InboxDeliveryStore (or reopen the hive) to rebuild totals.
 */
export function seedAgedInboxReceipts(owner: DbOwner, agentId: string, sessionId: string, size: number): void {
  const db = dbOf(owner);
  db.exec("DROP TABLE inbox_receipt_totals");
  db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO inbox_deliveries(id, agent_id, session_id, through_seq, seqs, attempts, offered_at, lease_until, acknowledged_at)
    SELECT 'aged-' || i, ?, ?, 0, '[0]', 1, 1, 2, 100 FROM n`).run(size, agentId, sessionId);
}

// ---------------------------------------------------------------------------
// Time and presence
// ---------------------------------------------------------------------------

export interface PresenceUpdate {
  online?: boolean;
  lastSeenAt?: number;
}

/** Sets presence columns for one agent id, or for every agent with the given role. */
export function setAgentPresence(owner: DbOwner, target: string | { role: string } | { notRole: string }, presence: PresenceUpdate): void {
  const set: Values = {};
  if (presence.online !== undefined) set.online = presence.online ? 1 : 0;
  if (presence.lastSeenAt !== undefined) set.last_seen_at = presence.lastSeenAt;
  if (typeof target === "object" && "notRole" in target) {
    const keys = Object.keys(set);
    dbOf(owner).prepare(`UPDATE agents SET ${keys.map(key => `${ident(key)} = ?`).join(", ")} WHERE role != ?`)
      .run(...keys.map(key => set[key]), target.notRole);
    return;
  }
  updateRows(owner, "agents", set, typeof target === "string" ? { id: target } : { role: target.role });
}

/** Moves a timestamp column back (default: to the epoch) so expiry/retention logic sees it as old. */
export function backdate(owner: DbOwner, table: string, column: string, where: Where = {}, to = 0): number {
  return updateRows(owner, table, { [column]: to }, where);
}

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

export interface FailureOptions {
  /** Which write fails; defaults to "insert". */
  on?: "insert" | "update" | "delete";
  /** BEFORE (default) or AFTER the row change. */
  timing?: "before" | "after";
  /** Optional SQL condition over NEW/OLD, e.g. "NEW.update_id = 2". */
  when?: string;
  /** Error text raised by SQLite; defaults to "injected failure". */
  message?: string;
  /** Persist the trigger in the database file instead of the connection (default false). */
  persistent?: boolean;
}

let triggerSeq = 0;

/**
 * Makes writes to `table` fail with `RAISE(ABORT, message)` until the returned
 * function is called. Use it to prove a multi-table operation is atomic.
 */
export function failWrites(owner: DbOwner, table: string, options: FailureOptions = {}): () => void {
  const db = dbOf(owner);
  const name = `fixture_fail_${ident(table)}_${++triggerSeq}`;
  const message = (options.message ?? "injected failure").replaceAll("'", "''");
  const when = options.when ? ` WHEN ${options.when}` : "";
  db.exec(`CREATE ${options.persistent ? "" : "TEMP "}TRIGGER ${name} ${(options.timing ?? "before").toUpperCase()} ${(options.on ?? "insert").toUpperCase()} ON ${table}${when}
    BEGIN SELECT RAISE(ABORT, '${message}'); END`);
  return () => db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

/** Drops a table so tests can simulate a legacy schema before reopening the hive. */
export function dropTable(owner: DbOwner, table: string): void {
  dbOf(owner).exec(`DROP TABLE ${ident(table)}`);
}
