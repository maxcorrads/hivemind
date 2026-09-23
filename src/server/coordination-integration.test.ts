import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hive } from './hive.ts';
import { addChannelMember, insertRows, markInboxRead, removeChannelMember } from './test-fixtures.ts';

test('notification wakes recheck authorization without hydrating a full roster for each recipient', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coordination-wake-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.getAgent('human');
  const brain = hive.join({ role: 'brain' }).agent;
  const local = hive.join({ role: 'worker', seniority: 'mid' }).agent;
  const room = hive.createChannel(brain, { name: 'local-work', type: 'private', memberNames: [local.name] });
  const foreignProject = hive.createProject(human, { name: 'Other', slug: 'other' });
  const foreign = hive.join({ role: 'worker', seniority: 'mid', project: foreignProject.slug }).agent;
  // A damaged membership must not grant cross-project visibility or wake access.
  addChannelMember(hive, room.id, foreign.id);
  const peers = Array.from({ length: 40 }, (_, i) => `local-peer-${i}`);
  insertRows(hive, 'agents', peers.map(id => ({ id, name: id, role: 'worker', seniority: 'mid', token_hash: id,
    online: 0, last_seen_at: 1, created_at: 1, inbox_cursor: 0, project_id: brain.projectId })));
  insertRows(hive, 'channel_members', peers.map(id => ({ channel_id: room.id, agent_id: id })));
  markInboxRead(hive);
  const queued: string[] = [];
  hive.bus.on('queued', (event: { agentId: string }) => queued.push(event.agentId));
  const original = hive.getChannel.bind(hive);
  let channelLoads = 0;
  const mock = t.mock.method(hive, 'getChannel', (...args: Parameters<Hive['getChannel']>) => {
    channelLoads++;
    return original(...args);
  });
  const sent = hive.postMessage(brain, { channel: room.id, body: 'Visible local work', eventType: 'assignment' });
  mock.mock.restore();
  assert.ok(channelLoads <= 3, `full channel hydration must not scale with recipients: ${channelLoads}`);
  assert.ok(queued.includes(local.id));
  assert.equal(queued.filter(id => id.startsWith('local-peer-')).length, 40);
  assert.ok(!queued.includes(foreign.id));
  assert.equal(hive.isFor(foreign, sent), false);
  assert.throws(() => hive.getVisibleMessage(foreign, sent.seq), /Cannot read/);
  const batch = await hive.wait(local, 1);
  assert.deepEqual(batch.delivery!.messageSeqs, [sent.seq]);
  removeChannelMember(hive, room.id, local.id);
  await assert.rejects(hive.wait(local, 1), /no longer accessible/);
  assert.equal(hive.inbox.pending(local.id)!.id, batch.delivery!.id, 'access loss must not silently acknowledge the pending receipt');
});
