import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations } from './index.ts';
import { launchSessionFencing } from './launch-session-fencing.ts';

test('launch session fencing preserves bound launches and does not guess the session of older prepared commands', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  applyMigrations(db, { target: 42 });
  db.exec("INSERT INTO projects(id,slug,name,created_at) VALUES ('p','project','Project',1)");
  db.exec("INSERT INTO agents(id,name,role,token_hash,last_seen_at,created_at,project_id) VALUES ('a','Brain','brain','new-session',1,1,'p')");
  for (const id of ['bound', 'pending']) db.prepare(`INSERT INTO launch_sessions
    (id,ticket_hash,project_id,expected_agent_id,agent_id,settings,provider,session_id,captured,created_at,bound_at)
    VALUES (?,?,'p','a',?,'encrypted-unchanged','claude','conversation',1,1,?)`)
    .run(id, id, id === 'bound' ? 'a' : null, id === 'bound' ? 1 : null);
  db.exec("INSERT INTO agent_launch_settings(agent_id,launch_id) VALUES ('a','bound')");
  const rows = () => db.prepare('SELECT * FROM launch_sessions ORDER BY id').all();
  const before = rows();
  const pointers = db.prepare('SELECT * FROM agent_launch_settings').all();
  assert.deepEqual(applyMigrations(db).map(m => m.name), ['launch_session_fencing']);
  assert.deepEqual(rows().map(row => ({ ...row })), before.map(row => ({ ...row, previous_session_fingerprint: null })));
  assert.deepEqual(db.prepare('SELECT * FROM agent_launch_settings').all(), pointers);
  launchSessionFencing(db);
  assert.deepEqual(rows().map(row => ({ ...row })), before.map(row => ({ ...row, previous_session_fingerprint: null })));
});
