import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Hive } from '../src/server/hive.ts';
import { TIMELINE_EVENT_LIMIT, TIMELINE_RETENTION_MS } from '../src/shared/timeline.ts';

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

export function measureTimelineOverhead({ rows = TIMELINE_EVENT_LIMIT, samples = 50 } = {}) {
  assert.ok(Number.isInteger(rows) && rows >= 2 && rows <= TIMELINE_EVENT_LIMIT, `rows must be 2..${TIMELINE_EVENT_LIMIT}`);
  assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 500, 'samples must be 1..500');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-timeline-bench-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  try {
    const brain = hive.identity.join({ role: 'brain' }), worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
    const channel = hive.channels.createChannel(brain.agent, { name: 'timeline-bench', type: 'private', memberNames: [worker.agent.name] });
    const traceId = randomUUID();
    const writeStart = performance.now();
    const root = hive.messages.postMessage(brain.agent, { channel: channel.id, body: 'benchmark root', traceId });
    for (let index = 1; index < rows; index++)
      hive.messages.postMessage(brain.agent, { channel: channel.id, threadId: root.id, body: `progress ${index}`, eventType: 'progress', traceId });
    const writeTotal = performance.now() - writeStart;

    for (let index = 0; index < 10; index++) hive.timeline.trace(brain.agent, traceId);
    const timings = [];
    for (let index = 0; index < samples; index++) {
      const start = performance.now();
      hive.timeline.trace(brain.agent, traceId);
      timings.push(performance.now() - start);
    }
    timings.sort((left, right) => left - right);
    const stats = hive.timeline.stats();
    return {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      rows,
      eventsReturned: hive.timeline.trace(brain.agent, traceId).events.length,
      logicalTimelineBytes: stats.logicalBytes,
      logicalBytesPerProvenance: stats.logicalBytes / Math.max(1, stats.provenance),
      writeMs: { total: writeTotal, perMessage: writeTotal / rows },
      queryMs: {
        p50: percentile(timings, 0.5),
        p95: percentile(timings, 0.95),
        max: timings.at(-1),
        samples,
      },
      caps: stats.caps,
      retentionMs: TIMELINE_RETENTION_MS,
      note: 'Same-machine observational workload. Write timing includes the normal message write plus timeline metadata; it is not an A/B baseline or cross-runner CI SLA.',
    };
  } finally {
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { rows: TIMELINE_EVENT_LIMIT, samples: 50, output: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--rows') options.rows = Number(argv[++index]);
    else if (arg === '--samples') options.samples = Number(argv[++index]);
    else if (arg === '--output') options.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = measureTimelineOverhead(options);
  const json = JSON.stringify(result, null, 2) + '\n';
  if (options.output) writeFileSync(options.output, json);
  else process.stdout.write(json);
  return result;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
