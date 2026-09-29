import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, MIGRATIONS } from './index.ts';
import { simpleContract } from './channel-archives.ts';

const legacy = { mode: 'finite', purpose: 'Investigate sensors', rules: ['Assign on blockers'], limits: ['No devices'],
  coordinator: 'Atlas', participants: [{ name: 'Forge', boundary: 'Validate inputs' }, { name: 'Quill', boundary: '' }],
  completion: ['Human ends monitoring'], originTaskId: null };

test('older contracts fold their text fields into one instructions brief and keep the enforced names', () => {
  assert.deepEqual(simpleContract(legacy), {
    instructions: 'Investigate sensors\nRules:\n- Assign on blockers\nLimits:\n- No devices\nWorker boundaries:\n- Forge: Validate inputs\nCompletion:\n- Human ends monitoring',
    coordinator: 'Atlas', participants: ['Forge', 'Quill'] });
  const current = { instructions: 'Already simple', coordinator: 'Atlas', participants: ['Forge'] };
  assert.deepEqual(simpleContract(current), current, 'rerunning keeps a converted contract');
});

test('channel_archives backfills archived rooms and rewrites room and audit snapshots', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync(new URL('../fixtures/storage/main-populated-v2.sql', import.meta.url), 'utf8'));
  const version = MIGRATIONS.find(m => m.name === 'channel_archives')!.version;
  applyMigrations(db, { target: version - 1 });
  const channel = String(db.prepare('SELECT channel_id FROM rooms').get()!.channel_id);
  const room = { channelId: channel, revision: 2, contractVersion: 1, state: 'archived', updatedAt: 42, summarySeq: 7,
    archivedRunning: 'finish', contract: legacy };
  db.prepare('UPDATE rooms SET snapshot=?').run(JSON.stringify(room));
  db.prepare('UPDATE room_events SET snapshot=?').run(JSON.stringify({ ...room, state: 'active', revision: 1 }));
  assert.deepEqual(applyMigrations(db, { target: version }).map(m => m.name), ['channel_archives']);
  assert.deepEqual(db.prepare('SELECT channel_id, archived_at FROM channel_archives').all().map(r => ({ ...r })),
    [{ channel_id: channel, archived_at: 42 }]);
  const stored = JSON.parse(String(db.prepare('SELECT snapshot FROM rooms').get()!.snapshot));
  assert.deepEqual(stored.contract, simpleContract(legacy));
  assert.equal('summarySeq' in stored || 'archivedRunning' in stored, false);
  const audit = JSON.parse(String(db.prepare('SELECT snapshot FROM room_events').get()!.snapshot));
  assert.deepEqual(audit.contract, simpleContract(legacy));
  assert.equal(audit.state, 'active', 'only the current room decides the archive state');
});
