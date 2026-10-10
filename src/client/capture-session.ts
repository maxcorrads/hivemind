import { nativeSessionId } from '../shared/native-session.ts';
import { launchTicketSchema } from '../shared/launch-settings.ts';

/** SessionStart / Cursor create-chat callback. No transcript reading or model invocation. */
export async function captureSession(args: string[], input: AsyncIterable<Uint8Array | string> = process.stdin, request = fetch): Promise<void> {
  const value = (name: string, fallback?: string) => {
    const index = args.indexOf(name);
    if (index < 0 && fallback) return fallback;
    if (index < 0 || args.lastIndexOf(name) !== index || !args[index + 1]) throw new Error(`Missing or repeated ${name}`);
    return args[index + 1];
  };
  const ticket = launchTicketSchema.parse(value('--ticket', process.env.HIVEMIND_LAUNCH_TICKET));
  const url = new URL(value('--url', process.env.HIVEMIND_URL));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw new Error('Session callback requires a local Hivemind URL');
  let body = '';
  for await (const chunk of input) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error('Session callback input is too large');
  }
  let sessionId: string;
  if (args.includes('--hook')) {
    const event = JSON.parse(body) as { hook_event_name?: string; session_id?: string; source?: string };
    if (event.hook_event_name !== 'SessionStart' || !['startup', 'resume'].includes(event.source ?? '')) return;
    sessionId = nativeSessionId(event.session_id ?? '');
  } else sessionId = nativeSessionId(body, 'cursor');
  const response = await request(new URL('/api/launch-session/capture', url), { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ticket}` },
    body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(8_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Hivemind could not record the conversation (${response.status}); check this launch before resuming.`);
}
