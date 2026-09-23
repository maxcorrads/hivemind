// Fake `opencode` seat for #136 host tests. It speaks the Hivemind agent HTTP API on loopback only, never a provider.
// Behaviour is read from the JSON file named by FAKE_SEAT_CONTROL:
//   { "behavior": "complete" | "wrong_result" | "hang" | "crash" | "no_usage" | "double_join", "tokens": 40, "version": "1.0.0-fake" }
// double_join: every worker seat registers a second worker, so the initial capacity differs from the manifest.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const control = JSON.parse(readFileSync(process.env.FAKE_SEAT_CONTROL, 'utf8'));
if (args.includes('--version')) { console.log(control.version ?? '1.0.0-fake'); process.exit(0); }

const prompt = args.at(-1), workspace = args[args.indexOf('--dir') + 1];
const base = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).mcp.hivemind.environment.HIVEMIND_URL;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Fake seat only talks to a loopback Hivemind');
const role = /^Seat: brain$/m.test(prompt) ? 'brain' : 'worker';
const behavior = control.behavior ?? 'complete';

async function call(route, body, token) {
  const response = await fetch(`${base}${route}`, { method: 'POST', body: JSON.stringify(body ?? {}),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`${route} ${response.status} ${await response.text()}`);
  return response.json();
}
const usage = tokens => { if (behavior !== 'no_usage') console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { total: tokens } } })); };

const joined = await call('/api/agent/join', { role, ...(role === 'worker' ? { seniority: 'mid' } : {}) });
usage(Math.floor((control.tokens ?? 40) / 2));
if (role === 'worker') {
  if (behavior === 'double_join') await call('/api/agent/join', { role, seniority: 'junior' });
  for (;;) await delay(1_000);
}

const { sessionId } = await call('/api/agent/inbox/session', { sessionId: randomUUID() }, joined.token);
let request = null;
while (!request) {
  const mail = await call('/api/agent/wait', { sessionId, timeoutMs: 500 }, joined.token);
  request = [...(mail.messages ?? []), ...(mail.mentions ?? [])]
    .find(m => m.authorRole === 'human' && !m.threadId && !String(m.body).startsWith('[Hivemind adaptive topology')) ?? null;
}
if (behavior === 'crash') process.exit(3);
if (behavior === 'hang') { for (;;) await delay(1_000); }
writeFileSync(path.join(workspace, 'result.txt'), behavior === 'wrong_result' ? 'wrong\n' : `${request.body.trim()}\n`);
usage(control.tokens ?? 40);
await call(`/api/agent/threads/${encodeURIComponent(request.id)}/status`, { status: 'done' }, joined.token);
