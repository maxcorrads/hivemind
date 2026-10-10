import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureSession } from './capture-session.ts';

const ticket = `hml_${'1'.repeat(64)}`;
const args = ['--url', 'http://127.0.0.1:7420', '--ticket', ticket];
async function* stdin(value: string) { yield value; }
test('native callback sends only ID to its local launch capability; no hook/transcript content is forwarded', async () => {
  const id = '67d735d1-9e33-4a61-9645-a931afc97f2b';
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://127.0.0.1:7420/api/launch-session/capture');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${ticket}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { sessionId: id });
    assert.equal(init?.redirect, 'error');
    return new Response('{}');
  };
  await captureSession([...args, '--hook'], stdin(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup',
    session_id: id, transcript_path: '/private/transcript', model: 'ignored' })), request);
  await captureSession(args, stdin(`${id}\n`), request);
  await captureSession([...args, '--hook'], stdin(JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' })), request);
  assert.equal(calls, 2);
  await assert.rejects(captureSession([...args, '--url', 'bad'], stdin('bad'), request));
  await assert.rejects(captureSession(['--url', 'https://external.example', '--ticket', ticket], stdin(id), request), /local/);
  await assert.rejects(captureSession(args, stdin('ambiguous output\nother'), request), /ID/);
  await assert.rejects(captureSession(args, stdin('x'.repeat(65 * 1024)), request), /too large/);
  await assert.rejects(captureSession(args, stdin(id), async () => new Response('', { status: 409 })), /409/);
});
