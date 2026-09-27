import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hive } from './hive.ts';
import { AgentLifecycleLog } from './services/agent-lifecycle-log.ts';
import { HiveError } from '../shared/types.ts';

test('lifecycle history is durable, isolated by agent, keyset-paged, and pruned in batches', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hive-agent-lifecycle-log-'));
  const hive = new Hive(path.join(home, 'hive.db'), { routineBatchMs: 0 });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.close(); rmSync(home, { recursive: true, force: true }); });
  const human = hive.identity.getAgent('human');
  const project = hive.projects.listProjects()[0] ??
    hive.projects.createProject(human, { name: 'Acme', slug: 'acme', worktree: home });
  const brain = hive.identity.join({ role: 'brain', project: project.slug }).agent;
  const worker = hive.identity.join({ role: 'worker', seniority: 'mid', project: project.slug }).agent;
  const log = new AgentLifecycleLog({ storage: hive.storage, bus: hive.bus });
  const baseline = log.list(worker.id).items.map(item => item.seq);
  const brainBaseline = log.list(brain.id).items.map(item => item.summary);
  const record = (agentId: string, at: number, summary: string) => log.record({ agentId,
    projectId: project.id, actorId: human.id, kind: 'identity_edited', summary, at, source: 'human_ui' });
  const oldest = record(worker.id, 100, 'Renamed worker');
  const middle = record(worker.id, 101, 'Changed focus');
  const newest = record(worker.id, 102, 'Changed seniority');
  record(brain.id, 103, 'Renamed brain');
  const first = log.list(worker.id, undefined, 2);
  assert.deepEqual(first.items.map(item => item.seq), [newest.seq, middle.seq]);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBefore, middle.seq);
  assert.deepEqual(first.items[0], newest);
  const seen = first.items.map(item => item.seq);
  let next: number | null = first.nextBefore;
  while (next !== null) {
    const page = log.list(worker.id, next, 2);
    seen.push(...page.items.map(item => item.seq));
    next = page.nextBefore;
  }
  assert.deepEqual(seen, [newest.seq, middle.seq, oldest.seq, ...baseline]);
  assert.equal(log.prune(102, 1), 2);
  assert.deepEqual(log.list(worker.id).items.map(item => item.seq), [newest.seq, ...baseline]);
  assert.deepEqual(log.list(brain.id).items.map(item => item.summary), ['Renamed brain', ...brainBaseline]);
});

test('lifecycle log validates bounds and rolls back with the enclosing mutation', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hive-agent-lifecycle-log-'));
  const hive = new Hive(path.join(home, 'hive.db'), { routineBatchMs: 0 });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.close(); rmSync(home, { recursive: true, force: true }); });
  const human = hive.identity.getAgent('human');
  const log = new AgentLifecycleLog({ storage: hive.storage, bus: hive.bus });
  const input = { agentId: human.id, projectId: null, actorId: human.id, kind: 'identity_edited' as const,
    summary: 'Edited identity', source: 'human_ui' as const, at: 100 };
  assert.throws(() => hive.storage.transaction(() => { log.record(input); throw new Error('rollback'); }), /rollback/);
  assert.deepEqual(log.list(human.id).items, []);
  assert.throws(() => log.record({ ...input, summary: 'x'.repeat(401) }),
    (error: unknown) => error instanceof HiveError && error.status === 400);
  for (const [before, limit] of [[0, 1], [1, 0], [1, 101], [1.5, 1]]) {
    assert.throws(() => log.list(human.id, before, limit),
      (error: unknown) => error instanceof HiveError && error.status === 400);
  }
  assert.equal(log.prune(-1), 0, 'a retention window may extend before the epoch');
  assert.throws(() => log.prune(0.5), (error: unknown) => error instanceof HiveError && error.status === 400);
});
