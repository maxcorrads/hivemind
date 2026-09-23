import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hive } from '../server/hive.ts';
import { startServer } from '../server/serve.ts';
import type { CapabilityCard, RoutingSuggestions } from '../shared/routing.ts';
import { normalizeChannelReference, resolveVisibleWorkerReference } from './index.ts';
import { childEnv } from '../test-support/child-process.ts';

test('MCP reference helpers normalize display channels and resolve visible worker names safely', () => {
  assert.equal(normalizeChannelReference('#fixture-room'), 'fixture-room');
  assert.equal(normalizeChannelReference('fixture-room'), 'fixture-room');
  const roster = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Loom', role: 'worker', seniority: 'mid', focus: null, online: true, lastSeenAt: 0, createdAt: 0, projectId: 'p', project: 'chapter' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Brain', role: 'brain', seniority: null, focus: null, online: true, lastSeenAt: 0, createdAt: 0, projectId: 'p', project: 'chapter' },
  ] as const;
  assert.equal(resolveVisibleWorkerReference('Loom', roster as any), roster[0].id);
  assert.equal(resolveVisibleWorkerReference('loom', roster as any), roster[0].id);
  assert.equal(resolveVisibleWorkerReference(roster[0].id, roster as any), roster[0].id);
  assert.throws(() => resolveVisibleWorkerReference('Missing', roster as any), /No visible worker/);
});

test('real CLI and MCP share opt-in cards and advisory choices without changing task authority', { timeout: 20000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'routing-clients-')), hive = new Hive(path.join(dir, 'hive.db'));
  const server = startServer({ hive, port: 0, telegram: false }), client = new Client({ name: 'routing-fixture', version: '1' });
  let transport: StdioClientTransport | undefined;
  try {
    const port = await server.ready, brain = hive.identity.join({ role: 'brain' }), worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
    const task = hive.tasks.assign(brain.agent, { requestId: 'one-task', worker: worker.agent.name,
      contract: { objective: 'Fixture', scope: [], nonGoals: [], acceptanceCriteria: ['Review'], evidenceSeqs: [], dependencies: [] } }).task;
    const env = (token: string) => childEnv({ PATH: process.env.PATH ?? '', HIVEMIND_TOKEN: token, HIVEMIND_URL: `http://127.0.0.1:${port}`, HIVEMIND_HOME: path.join(dir, 'client') });
    const args = ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts')];
    const card: CapabilityCard = { enabled: true, capabilities: ['parser'], modes: ['implementation'], model: null, host: null, availableContext: null, availability: 'available', maxInProgress: 1 };
    const file = path.join(dir, 'card.json'); writeFileSync(file, JSON.stringify({ expectedRevision: 0, card }));
    const cli = await promisify(execFile)(process.execPath, [...args, 'capabilities', 'set', '--input', file], { cwd: dir, env: env(worker.token), timeout: 5000 });
    assert.equal(JSON.parse(cli.stdout).capability.revision, 1);
    transport = new StdioClientTransport({ command: process.execPath, args: [...args, 'mcp'], cwd: dir, env: env(brain.token), stderr: 'pipe' });
    await client.connect(transport, { signal: t.signal, timeout: 5000 });
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: arguments_ }, CallToolResultSchema, { signal: t.signal, timeout: 5000 }));
      assert.notEqual(result.isError, true, JSON.stringify(result)); const item = result.content[0]; assert.ok(item?.type === 'text'); return JSON.parse(item.text);
    };
    assert.deepEqual((await call('get_worker_capabilities', { workerId: worker.agent.id })).capability.card, card);
    assert.deepEqual((await call('get_worker_capabilities', { workerId: worker.agent.name })).capability.card, card);
    const suggestion = await call('suggest_workers', { taskId: task.id, requiredCapabilities: ['parser'], mode: 'implementation', category: 'parsing' }) as RoutingSuggestions;
    assert.equal(suggestion.candidates[0]!.workerId, worker.agent.id); assert.equal(suggestion.candidates[0]!.evidence.reviewed, 0);
    const unfiltered = await call('suggest_workers', { taskId: task.id, mode: 'implementation', category: 'general' }) as RoutingSuggestions;
    assert.equal(unfiltered.candidates[0]!.workerId, worker.agent.id);
    const choice = { taskId: task.id, expectedRevision: 1, workerId: worker.agent.id, requestId: 'one-preference', reason: 'Inspect this worker first' };
    const first = await call('record_routing_override', choice), second = await call('record_routing_override', choice);
    assert.equal(first.message.id, second.message.id); assert.equal(first.assigned, false);
    assert.equal(hive.tasks.get(brain.agent, task.id).revision, 1);
    const denied = await client.callTool({ name: 'set_capabilities', arguments: { expectedRevision: 0, card } });
    assert.equal(denied.isError, true);
  } finally {
    try { await client.close(); await transport?.close(); }
    finally { await server.shutdown(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});
