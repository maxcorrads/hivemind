from pathlib import Path
import subprocess

def edit(path, old, new):
    p=Path(path); s=p.read_text(); assert old in s, (path,old[:120]); p.write_text(s.replace(old,new))

for p in ['src/server/hive.ts','web/App.tsx']:
    s=Path(p).read_text(); s='\n'.join(line for line in s.split('\n') if not line.startswith("import { isDirectRecipient }"));Path(p).write_text(s)
edit('src/server/read-state.ts', '.all(...q.params, actorId) as', '.all(...q.params, actorId, actorId) as')
edit('src/server/read-state.ts', '.run(actorId, ...q.params, actorId);', '.run(actorId, ...q.params, actorId, actorId);')
edit('web/tasks.test.tsx', '    task: currentTask, messages, threads: [], replyCounts: {} };', '    threadId: task.id, task: currentTask, messages, threads: [], replyCounts: {} };')
# Retain the source PR DOM-based injection regressions instead of its obsolete string matcher.
p=Path('web/plugins.test.tsx');s=p.read_text();src=subprocess.check_output(['git','show','f039306217e13f07a28716aba1ee42137dbec165:web/plugins.test.tsx'],text=True)
a='test("field-free plugins remain configurable, without injecting package markup"';b='test("a broken enabled plugin can be disabled without configuring it"'
s=s[:s.index(a)]+src[src.index(a):src.index(b)]+s[s.index(b):];p.write_text(s)
# The read-receipt implementation deliberately replaced applyMessageToSnap. Test the canonical state instead.
p=Path('web/inbox-delivery.test.tsx');s=p.read_text();s=s.replace("import { applyMessageToSnap } from './App.tsx';\nimport type { Snapshot } from './api.ts';\nimport type { Message } from '../src/shared/types.ts';", "import { mkdtempSync, rmSync } from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\nimport { Hive } from '../src/server/hive.ts';")
a=s.index("test('live explicit Human recipients")
s=s[:a]+'''test('explicit Human recipients enter For you once and remain until the exact scoped receipt', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'human-target-read-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.getAgent('human'), brain = hive.join({ role: 'brain' }).agent;
  const room = hive.createChannel(brain, { name: 'targeted-read', type: 'private' });
  const root = hive.postMessage(brain, { channel: room.id, body: 'Decision needed', recipients: ['Human'] });
  const reply = hive.postMessage(brain, { channel: room.id, threadId: root.id,
    body: '@Human follow-up', recipients: ['Human'] });
  const before = hive.readSnapshot(human);
  assert.deepEqual(before.mentions.map(m => m.id), [reply.id, root.id]);
  assert.equal(before.mentionCounts[brain.project!], 2);
  // A GET/open view is read-only. Mention plus explicit recipient must count once.
  hive.listMessages(human, room.id);
  assert.deepEqual(hive.readSnapshot(human).mentions.map(m => m.id), [reply.id, root.id]);
  hive.markMessagesRead(human, room.id, [root.seq]);
  assert.deepEqual(hive.readSnapshot(human).mentions.map(m => m.id), [reply.id]);
  hive.markMessagesRead(human, room.id, [root.seq]);
  assert.deepEqual(hive.readSnapshot(human).mentions.map(m => m.id), [reply.id]);
  hive.markMessagesRead(human, room.id, [reply.seq], root.id);
  assert.deepEqual(hive.readSnapshot(human).mentions, []);
  const next = hive.postMessage(brain, { channel: room.id, body: 'Next decision', recipients: ['Human'] });
  assert.deepEqual(hive.mentionInbox(human).messages.map(m => m.id), [next.id]);
  hive.markMentionsSeen(human, brain.projectId!);
  assert.deepEqual(hive.readSnapshot(human).mentions, []);
  assert.equal(before.mentions.length, 2, 'Do not mutate previous read snapshots');
});
''';p.write_text(s)
# Authorize test sockets/HTTP with the same current Human boundary as the actual application.
p='src/server/coordination-contracts.test.ts'
edit(p,"    const closed = server.server.listening ? once(server.server, 'close') : Promise.resolve();\n    server.shutdown(); server.server.closeAllConnections();\n    await closed;", "    await server.shutdown();")
edit(p,"  // /ws is the existing local Human/admin UI transport, not an agent-scoped API.\n  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(socket);", """  const session = await fetch(`${base}/api/ui/session`, { method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie')!.split(';', 1)[0]!;
  const humanHeaders = { origin: base, cookie, 'x-hivemind-ui': '1' };
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: base, cookie, 'sec-fetch-site': 'same-origin' },
  }); sockets.push(socket);""")
edit(p,"headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },", "headers: { ...(url.startsWith('/api/ui/') ? humanHeaders : {}),\n        ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },")
edit('web/coordination-shell.test.tsx', '    requests.push(url); return app.request(url, init);', "    requests.push(url);\n    if (url === '/api/ui/session') return Response.json({ ok: true });\n    return app.request(url, init);")
edit('web/room-retry.test.tsx', "  IS_REACT_ACT_ENVIRONMENT: true });", "  location: window.location, IS_REACT_ACT_ENVIRONMENT: true });")
edit('web/room-retry.test.tsx', "  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {\n    if (init?.method === 'POST') {", "  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {\n    if (url === '/api/ui/session') return Response.json({ ok: true });\n    if (init?.method === 'POST') {")
edit('src/mcp/wait-loop.ts', '      if (waitHasMail(result)) return result;', '''      if (waitHasMail(result)) return result;
      // A successful short poll may ask us to wait for a fixed routine-progress window.
      // Keep this inside the tool; successful idle polls never consume retry budget.
      if (Number.isFinite(result.retryAfterMs) && result.retryAfterMs! > 0) {
        await delay(Math.min(result.retryAfterMs!, 1000), opts.signal);
      }''')
import json
p=Path('package.json');j=json.loads(p.read_text());j['files'] += [n for n in ['COORDINATION.md','NOTIFICATIONS.md','ROOMS.md','TASK-PROTOCOL.md','DELIVERY-PROTOCOL.md'] if n not in j['files']];p.write_text(json.dumps(j,indent=2)+'\n')
edit('src/server/hive.ts', '''      const agent = this.getAgent(id);
      const channel = this.getChannel(ch.id);
      if (!this.canSeeChannel(agent, channel)) continue;
      if (!this.isFor(agent, msg)) continue;''', '''      const agent = this.getAgent(id);
      // The notification classifier rechecks current project, channel membership,
      // role and routing in SQL. Do not hydrate the entire roster for every member.
      if (!this.isFor(agent, msg)) continue;''')
