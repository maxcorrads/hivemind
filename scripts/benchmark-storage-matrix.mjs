/** Local, synthetic measurements. Never uses an existing hive or a provider. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MATRIX_VERSION = 1;
const base = { agents: 1, foreignAgents: 1, foreignProjects: 1, foreignChannels: 1, foreignBacklog: 100, messages: 40, bodyBytes: 128 };
export const fixtures = [
  { id: 'baseline', ...base },
  { id: 'active-agents-4', ...base, agents: 4 },
  { id: 'foreign-agents-50000', ...base, foreignAgents: 50_000 },
  { id: 'foreign-projects-8', ...base, foreignProjects: 8 },
  { id: 'foreign-channels-2000', ...base, foreignChannels: 2_000 },
  { id: 'foreign-backlog-10000', ...base, foreignBacklog: 10_000 },
  { id: 'local-backlog-1200', ...base, messages: 1_200 },
  { id: 'body-bytes-1', ...base, bodyBytes: 1 },
  { id: 'body-bytes-4000', ...base, bodyBytes: 4_000 },
];
export function summary(values) {
  if (!values.length || values.some(x => !Number.isFinite(x) || x < 0)) throw new Error('Expected finite nonnegative samples');
  const ordered = [...values].sort((a, b) => a - b);
  const round = x => Math.round(x * 1000) / 1000;
  return { samples: values.length, p50: round(ordered[Math.ceil(values.length * .5) - 1]),
    p95: round(ordered[Math.ceil(values.length * .95) - 1]), min: round(ordered[0]), max: round(ordered.at(-1)), raw: values.map(round) };
}
function instrument(db) {
  const prepare = db.prepare.bind(db); let state;
  const reset = () => { state = { statementExecutions: 0, returnedRows: 0 }; };
  reset();
  db.prepare = sql => {
    const statement = prepare(sql);
    for (const method of ['get', 'all', 'run']) {
      const original = statement[method].bind(statement);
      Object.defineProperty(statement, method, { value: (...args) => {
        state.statementExecutions++;
        const result = original(...args);
        if (method !== 'run') state.returnedRows += Array.isArray(result) ? result.length : Number(Boolean(result));
        return result;
      } });
    }
    return statement;
  };
  // These are JS-level executions/returned rows. SQLite VM visits, triggers and
  // db.exec are not inferred from this wrapper or mislabeled as scanned rows.
  return { reset, sample: () => ({ ...state }), restore: () => { db.prepare = prepare; } };
}
/**
 * A Hive operation, bound: on its owning service in current checkouts (hive.identity.getAgent) and on the
 * Hive itself in older ones compared by this benchmark. Undefined when neither has it.
 */
function op(hive, service, method) {
  const owner = typeof hive[service]?.[method] === 'function' ? hive[service] : hive;
  return owner[method]?.bind(owner);
}
export async function measureFixture(Hive, createApp, fixture, samples = 12) {
  assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 30);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-storage-matrix-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const delay = monitorEventLoopDelay({ resolution: 10 });
  let measurements;
  try {
    const human = op(hive, 'identity', 'getAgent')('human');
    const sender = op(hive, 'identity', 'join')({ role: 'worker', seniority: 'mid' }).agent;
    const readers = Array.from({ length: fixture.agents }, () => {
      const agent = op(hive, 'identity', 'join')({ role: 'brain' }).agent;
      return { agent, channel: op(hive, 'channels', 'openDm')(agent, sender.name).id,
        sessionId: op(hive, 'delivery', 'openInboxSession')?.(agent, randomUUID()) };
    });
    const projects = Array.from({ length: fixture.foreignProjects }, (_, i) => op(hive, 'projects', 'createProject')(human, { name: `Foreign ${i}`, slug: `foreign-${i}` }));
    const createAgent = hive.db.prepare(`INSERT INTO agents
      (id,name,role,seniority,token_hash,online,last_seen_at,created_at,inbox_cursor,project_id)
      VALUES (?,?,'worker','mid',?,0,1,1,0,?)`);
    const createChannel = hive.db.prepare("INSERT INTO channels (id,name,type,topic,created_by,created_at,project_id) VALUES (?,?,'private',NULL,'human',1,?)");
    const member = hive.db.prepare('INSERT INTO channel_members VALUES (?,?)');
    const noiseChannel = randomUUID();
    hive.db.exec('BEGIN');
    try {
      for (let i = 0; i < fixture.foreignAgents; i++) createAgent.run(`foreign-${i}`, `Foreign-${i}`, `not-a-token-${i}`, projects[i % projects.length].id);
      for (let i = 0; i < fixture.foreignChannels; i++) {
        const id = i ? randomUUID() : noiseChannel;
        createChannel.run(id, `foreign-room-${i}`, projects[i % projects.length].id);
        member.run(id, 'human'); member.run(id, 'foreign-0');
      }
      hive.db.exec('COMMIT');
    } catch (error) { hive.db.exec('ROLLBACK'); throw error; }
    const app = createApp(hive);
    const prepare = hive.db.prepare.bind(hive.db);
    const insert = prepare('INSERT INTO messages (id,channel_id,author_id,body,created_at) VALUES (?,?,?,?,1)');
    const body = 'x'.repeat(fixture.bodyBytes);
    const seedTraffic = () => {
      const cursor = Number(prepare('SELECT COALESCE(MAX(seq),0) AS n FROM messages').get().n);
      hive.db.exec('BEGIN');
      try {
        for (const reader of readers) prepare('UPDATE agents SET inbox_cursor=? WHERE id=?').run(cursor, reader.agent.id);
        const expected = readers.map(() => []);
        for (let i = 0; i < Math.max(fixture.foreignBacklog, fixture.messages); i++) {
          if (i < fixture.foreignBacklog) insert.run(randomUUID(), noiseChannel, 'foreign-0', body);
          if (i < fixture.messages) readers.forEach((reader, index) => {
            const id = randomUUID(); insert.run(id, reader.channel, sender.id, body); expected[index].push(id);
          });
        }
        hive.db.exec('COMMIT'); return expected;
      } catch (error) { hive.db.exec('ROLLBACK'); throw error; }
    };
    seedTraffic();
    measurements = instrument(hive.db);
    const metrics = {};
    const run = async (name, operation, count = samples) => {
      const duration = [], queries = [], rows = [], bytes = [];
      for (let i = -2; i < count; i++) {
        measurements.reset(); const started = performance.now();
        const value = await operation(i);
        const ms = performance.now() - started, measured = measurements.sample();
        if (i >= 0) {
          duration.push(ms); queries.push(measured.statementExecutions); rows.push(measured.returnedRows);
          bytes.push(Buffer.byteLength(JSON.stringify(value)));
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      metrics[name] = { elapsedMs: summary(duration), statementExecutions: summary(queries),
        returnedRows: summary(rows), serializedBytes: summary(bytes), rowsExamined: null };
    };
    delay.enable(); await new Promise(resolve => setTimeout(resolve, 20));
    await run('projectRoster', () => {
      const roster = op(hive, 'identity', 'listAgents')(readers[0].agent);
      assert.ok(roster.every(a => a.role === 'human' || a.projectId === readers[0].agent.projectId)); return roster;
    });
    await run('projectChannels', () => {
      const channels = op(hive, 'channels', 'listChannels')(readers[0].agent);
      assert.ok(channels.every(c => c.projectId === readers[0].agent.projectId)); return channels;
    });
    await run('history', () => {
      const result = op(hive, 'messageQueries', 'listMessages')(readers[0].agent, readers[0].channel, { limit: 20 });
      assert.ok(result.messages.every(m => m.channelId === readers[0].channel)); return result;
    });
    // A Human snapshot is deliberately global, not a project-A query. Bound
    // this benchmark itself rather than accidentally requesting quadratic work
    // from 50k synthetic users on the old implementation.
    if (fixture.foreignAgents <= 100 && fixture.foreignChannels <= 100) {
      await run('humanSnapshot', async () => {
        const response = await app.request('http://127.0.0.1:7420/api/ui/snapshot', { headers: { origin: 'http://127.0.0.1:7420' } });
        assert.equal(response.status, 200); return response.json();
      });
    } else metrics.humanSnapshot = { omitted: 'Global benchmark admission cap (100 foreign agents/channels); no latency or scaling claim for this case' };
    // Timing includes the full logical drain for concurrent readers, excluding
    // fixture insertion. Receipts are acknowledged only when this implementation
    // advertises them. Before/after #64 share the same original delivery protocol.
    const drains = [], waits = [], sizes = [], queries = [], rows = [];
    for (let sample = 0; sample < samples; sample++) {
      const expected = seedTraffic(); measurements.reset(); const started = performance.now();
      await Promise.all(readers.map(async (reader, index) => {
        const received = [];
        for (let attempts = 0; received.length < expected[index].length; attempts++) {
          assert.ok(attempts < 1000, 'Drain stalled or exceeded the bounded benchmark budget');
          const before = performance.now();
          const result = await op(hive, 'delivery', 'wait')(reader.agent, 1, undefined, { compact: false, sessionId: reader.sessionId });
          waits.push(performance.now() - before); sizes.push(Buffer.byteLength(JSON.stringify(result)));
          received.push(...result.messages.map(message => message.id));
          if (result.delivery) op(hive, 'delivery', 'acknowledgeInbox')(reader.agent, result.delivery.sessionId, result.delivery.id);
        }
        assert.deepEqual(received, expected[index], 'Loss, duplication or cross-project leakage');
      }));
      drains.push(performance.now() - started);
      const measured = measurements.sample(); queries.push(measured.statementExecutions); rows.push(measured.returnedRows);
      await new Promise(resolve => setImmediate(resolve));
    }
    metrics.delivery = { logicalDrainMs: summary(drains), inProcessWaitMs: summary(waits), responseBytes: summary(sizes),
      statementExecutionsPerDrain: summary(queries), returnedRowsPerDrain: summary(rows), rowsExamined: null };
    await new Promise(resolve => setTimeout(resolve, 20)); delay.disable();
    const round = n => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
    return { fixture, metrics, eventLoopDelayMs: { mean: round(delay.mean / 1e6), p95: round(delay.percentile(95) / 1e6), max: round(delay.max / 1e6) },
      memory: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed },
      assertions: 'Exact per-reader FIFO drain; project-scoped roster/channel/history; no duplicate or foreign delivered message' };
  } finally { measurements?.restore(); delay.disable(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
}
async function main() {
  const args = process.argv.slice(2);
  const source = path.resolve(args[0] ?? fileURLToPath(new URL('../src/server/hive.ts', import.meta.url)));
  const samples = Number(args[1] ?? 12), chosen = args[2] ?? 'all';
  assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 30, 'Samples must be 1..30');
  const selected = fixtures.filter(f => chosen === 'all' || f.id === chosen); assert.ok(selected.length, 'Unknown fixture');
  const { Hive } = await import(pathToFileURL(source).href);
  const { createApp } = await import(pathToFileURL(path.join(path.dirname(source), 'app.ts')).href);
  let commit = null;
  try { commit = execFileSync('git', ['-C', path.dirname(source), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* non-Git source export */ }
  const results = [];
  for (const fixture of selected) results.push(await measureFixture(Hive, createApp, fixture, samples));
  console.log(JSON.stringify({ version: MATRIX_VERSION, generatedAt: new Date().toISOString(), samples, sourceCommit: commit,
    sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'), node: process.version,
    platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? null,
    timingScope: 'In-process application calls; Human HTTP includes route serialization/parse. Other response-byte serialization is outside timing. Excludes network/model/setup. p95 is descriptive, not a confidence interval.',
    measurementScope: 'Statement get/all/run executions and returned rows, not SQLite VM steps or rows examined. Triggers/exec are not counted; rowsExamined remains null.',
    results }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
