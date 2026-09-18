// Run with: node --import tsx scripts/benchmark-storage-queries.mjs [path/to/other/src/server/hive.ts]
// Reports executed SQL and returned hydration rows, not an inferred wall-clock speedup.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const source = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])) : new URL("../src/server/hive.ts", import.meta.url);
const { Hive } = await import(source.href);
const home = mkdtempSync(path.join(os.tmpdir(), "hive-query-benchmark-"));
const hive = new Hive(path.join(home, "hive.db"));
try {
  const human = hive.getAgent("human");
  const worker = hive.join({ role: "worker", seniority: "mid" }).agent;
  const other = hive.createProject(human, { name: "Benchmark B", slug: "benchmark-b" });
  const agent = hive.db.prepare(`INSERT INTO agents
    (id,name,role,seniority,token_hash,online,last_seen_at,created_at,inbox_cursor,project_id)
    VALUES (?,?,'worker','mid','fixture',0,1,1,0,?)`);
  const channel = hive.db.prepare("INSERT INTO channels VALUES (?,?,'private',NULL,'human',1,?)");
  const member = hive.db.prepare("INSERT INTO channel_members VALUES (?,?)");
  hive.db.exec("BEGIN");
  for (let i = 0; i < 50_000; i++) agent.run(`b-${i}`, `B-${i}`, other.id);
  for (let i = 0; i < 2_000; i++) {
    channel.run(`room-${i}`, `room-${i}`, other.id); member.run(`room-${i}`, "human"); member.run(`room-${i}`, "b-0");
  }
  hive.db.exec("COMMIT");
  const original = hive.db.prepare.bind(hive.db);
  let statements = 0; let returnedRows = 0;
  hive.db.prepare = (sql) => {
    const statement = original(sql);
    for (const method of ["get", "all"]) {
      const run = statement[method].bind(statement);
      statement[method] = (...args) => {
        statements++;
        const result = run(...args);
        returnedRows += Array.isArray(result) ? result.length : Number(Boolean(result));
        return result;
      };
    }
    return statement;
  };
  const result = {};
  for (const [name, operation] of [["listAgents", () => hive.listAgents(worker)], ["listChannels", () => hive.listChannels(worker)]]) {
    statements = 0; returnedRows = 0;
    const rows = operation();
    result[name] = { statements, returnedHydrationRows: returnedRows, visibleResults: rows.length };
  }
  console.log(JSON.stringify({ node: process.versions.node, unrelatedAgents: 50_000, unrelatedChannels: 2_000, ...result }, null, 2));
} finally {
  hive.db.close(); rmSync(home, { recursive: true, force: true });
}
