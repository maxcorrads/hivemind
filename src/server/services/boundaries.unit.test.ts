import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Issues #169 / #200: hive.ts is a thin facade that wires the domain services in this
// directory and the domain stores. The services depend on narrow ports (ports.ts), never
// on Hive; every table has one owning domain, and only that domain's modules touch it.
const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.dirname(here);
const src = path.dirname(server);
const HIVE_LINE_BUDGET = 600;

const services = readdirSync(here)
  .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map(name => [name, readFileSync(path.join(here, name), "utf8")] as const);

const IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/.*$/gm, "");

/** Production modules (no tests, no migrations/fixtures), as paths relative to `root`. */
function modules(root: string, skip = (_relative: string) => false): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name), relative = path.relative(root, full).split(path.sep).join("/");
      if (skip(relative)) continue;
      if (statSync(full).isDirectory()) visit(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push([relative, readFileSync(full, "utf8")]);
    }
  };
  visit(root);
  return out;
}
const serverModules = modules(server, relative => relative === "migrations" || relative === "fixtures");

/**
 * Table ownership. Each domain lists its tables and the only modules (besides the services
 * layer in services/, which composes the core domain) that may reference them in SQL.
 */
const OWNERSHIP: Record<string, { modules: string[]; tables: string[] }> = {
  // Identity, projects, channels, messages, reads, files, bots and inbox delivery. Owned by the
  // services layer (services/*) and its stores; everything else goes through a service method.
  core: {
    modules: ["inbox-delivery.ts", "inbox-reader.ts", "read-state.ts", "send-requests.ts", "upload-budget.ts"],
    tables: ["projects", "agents", "channels", "channel_members", "messages", "threads", "reactions", "reads",
      "message_reads", "ui_read_revision", "attachments", "bot_credentials", "bot_events", "inbox_sessions",
      "inbox_deliveries", "inbox_receipts", "inbox_early_receipts", "inbox_receipt_totals", "send_requests", "upload_reservations", "upload_usage"],
  },
  // Structured tasks, advisory claims, rooms, Human decisions and routing evidence.
  coordination: {
    modules: ["tasks.ts", "task-coordination.ts", "rooms.ts", "decisions.ts", "routing.ts"],
    tables: ["task_records", "task_events", "task_request_aliases", "rooms", "room_acks", "room_events", "room_tasks",
      "source_links", "decision_requests", "decision_mutations", "routing_outcomes", "worker_capabilities"],
  },
  timeline: { modules: ["timeline.ts"], tables: ["message_provenance", "timeline_deliveries"] },
  notifications: { modules: ["notifications.ts"], tables: ["notification_subscriptions"] },
  adaptive: {
    modules: ["adaptive-topology-store.ts", "adaptive-evidence.ts", "jev-call-log.ts"],
    tables: ["adaptive_topology_executions", "adaptive_topology_locks", "adaptive_topology_events", "adaptive_topology_evaluated",
      "adaptive_topology_tasks", "adaptive_topology_messages", "adaptive_evidence_runs", "adaptive_evidence_attempts", "jev_calls"],
  },
  telegram: {
    modules: ["telegram-store.ts", "telegram-inbox.ts", "telegram-outbox.ts", "telegram-routing.ts"],
    tables: ["telegram_state", "telegram_bot_state", "telegram_bot_identities", "telegram_routing_migrations", "telegram_topics",
      "telegram_out", "telegram_in", "telegram_hold", "telegram_pending", "telegram_delivery_parts", "telegram_failures",
      "telegram_update_failures"],
  },
};

/** Reads of another domain's table that remain on purpose. Keep this list exact (stale entries fail). */
const CROSS_DOMAIN_EXCEPTIONS: Record<string, string> = {
  // The latency-sensitive inbox scan flags structured-task mail in the same statement it pages with.
  "inbox-reader.ts task_events": "task flag and bounded envelope of delivered task messages",
  // The evidence store also runs standalone (evidence export); it guards the channel foreign key itself.
  "adaptive-evidence.ts channels": "existence guard before recording gap evidence for a deleted channel",
};

const SQL_TABLE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-z_][a-z0-9_]*)\b/g;
const owner = new Map(Object.entries(OWNERSHIP).flatMap(([domain, { tables }]) => tables.map(table => [table, domain] as const)));
const domainOf = (module: string) => Object.entries(OWNERSHIP).find(([, { modules }]) => modules.includes(module))?.[0];

test("hive.ts stays within its line budget", () => {
  const lines = readFileSync(path.join(server, "hive.ts"), "utf8").split("\n").length;
  assert.ok(lines < HIVE_LINE_BUDGET, `hive.ts has ${lines} lines (budget ${HIVE_LINE_BUDGET}); move logic into a service`);
});

test("Hive has no delegating methods: only construction, wiring and close", () => {
  const source = withoutComments(readFileSync(path.join(server, "hive.ts"), "utf8"));
  const body = source.slice(source.indexOf("export class Hive"));
  const methods = [...body.matchAll(/^ {2}(?:(?:private|protected|public|static|async|readonly)\s+)*(\w+)\s*\(/gm)].map(match => match[1]!);
  assert.deepEqual(methods.sort(), ["bootstrap", "close", "constructor"]);
});

test("services never import hive.ts, not even for types", () => {
  assert.ok(services.length >= 10, "service discovery found the directory");
  const offenders = services.flatMap(([name, source]) =>
    [...source.matchAll(IMPORT)].map(match => match[1]!)
      .filter(specifier => /(^|\/)hive(\.ts)?$/.test(specifier))
      .map(specifier => `${name} imports ${specifier}`));
  assert.deepEqual(offenders, []);
});

test("services and stores are not typed against the Hive facade", () => {
  const stores = Object.values(OWNERSHIP).flatMap(domain => domain.modules)
    .concat(["adaptive-topology.ts", "adaptive-topology-actions.ts", "adaptive-topology-admission.ts",
      "adaptive-topology-capacity.ts", "adaptive-evidence-observer.ts", "adaptive-routing-diagnostics.ts"]);
  const offenders = [
    ...services.map(([name, source]) => [`services/${name}`, source] as const),
    ...serverModules.filter(([name]) => stores.includes(name)),
  ].filter(([, source]) => /\bHive\b/.test(withoutComments(source))).map(([name]) => name);
  assert.deepEqual(offenders, []);
});

test("ports.ts is type-only, so depending on a port never loads another module", () => {
  const ports = services.find(([name]) => name === "ports.ts")![1];
  const valueImports = [...ports.matchAll(/^\s*import\s+(?!type\b)[^;]*;/gm)].map(match => match[0].trim());
  assert.deepEqual(valueImports, []);
});

test("every table created by the migrations has exactly one owning domain", () => {
  const migrations = modules(path.join(server, "migrations"));
  const created = new Set(migrations.flatMap(([, source]) =>
    [...source.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\b/g)].map(match => match[1]!)));
  assert.ok(created.has("messages") && created.has("task_records"), "table discovery found the migrations");
  const owned = Object.values(OWNERSHIP).flatMap(domain => domain.tables);
  assert.equal(new Set(owned).size, owned.length, "a table is listed under two domains");
  assert.deepEqual([...created].filter(table => !owner.has(table)).sort(), [], "tables without an owning domain");
  assert.deepEqual(owned.filter(table => !created.has(table)).sort(), [], "ownership lists a table no migration creates");
  for (const module of Object.values(OWNERSHIP).flatMap(domain => domain.modules))
    assert.ok(serverModules.some(([name]) => name === module), `${module} (ownership map) exists`);
});

test("no module outside services/ and the owning stores references another domain's tables", () => {
  const seen = new Set<string>();
  const offenders = serverModules.filter(([name]) => !name.startsWith("services/") && name !== "test-fixtures.ts")
    .flatMap(([name, source]) => {
      const domain = domainOf(name);
      return [...new Set([...withoutComments(source).matchAll(SQL_TABLE)].map(match => match[1]!))]
        .filter(table => owner.has(table) && owner.get(table) !== domain)
        .filter(table => {
          const key = `${name} ${table}`;
          if (!(key in CROSS_DOMAIN_EXCEPTIONS)) return true;
          seen.add(key); return false;
        })
        .map(table => `${name} uses ${table} (owned by ${owner.get(table)})`);
    });
  assert.deepEqual(offenders, []);
  assert.deepEqual(Object.keys(CROSS_DOMAIN_EXCEPTIONS).filter(key => !seen.has(key)), [], "stale cross-domain exceptions");
});

test("the table check sees SQL table references, not prose", () => {
  const found = (sql: string) => [...sql.matchAll(SQL_TABLE)].map(match => match[1]);
  assert.deepEqual(found("SELECT 1 FROM messages m JOIN channels c ON c.id = m.channel_id"), ["messages", "channels"]);
  assert.deepEqual(found("INSERT OR IGNORE INTO threads(id) VALUES (?); UPDATE agents SET x = 1; DELETE FROM reads"), ["threads", "agents", "reads"]);
  assert.deepEqual(found("pass an exact name from agents/suggest_workers"), []);
});

test("outside storage and the stores, nothing reaches the hive database handle", () => {
  // Storage modules: the facade (construction and close), the unit of work, the stores
  // (ownership map), the services layer, and the adaptive observer that opens its stores.
  const storage = new Set(["hive.ts", "storage.ts", "adaptive-evidence-observer.ts", "test-fixtures.ts",
    ...Object.values(OWNERSHIP).flatMap(domain => domain.modules)]);
  const handle = /\.db\b(?!["'`])/;
  const offenders = serverModules
    .filter(([name]) => !name.startsWith("services/") && !storage.has(name))
    .filter(([, source]) => withoutComments(source).split("\n").some(line => handle.test(line.replace(/(["'`])hive\.db\1/g, ""))))
    .map(([name]) => name);
  assert.deepEqual(offenders, []);
  // Anywhere in src/, the Hive's own handle is only used by the facade itself.
  const hiveDb = /\bhive\??\.(?:storage\.)?db\b/;
  const direct = modules(src, relative => relative === "server/migrations" || relative === "server/fixtures")
    .filter(([name]) => name !== "server/hive.ts" && name !== "server/test-fixtures.ts")
    .filter(([, source]) => withoutComments(source).split("\n").some(line => hiveDb.test(line.replace(/(["'`])hive\.db\1/g, ""))))
    .map(([name]) => name);
  assert.deepEqual(direct, []);
});
