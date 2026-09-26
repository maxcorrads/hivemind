import { spawn } from 'node:child_process';
import { HiveError } from '../shared/types.ts';

/** Executes only a manifest-resolved local program, never a caller-supplied command or environment. */
export async function invokeBot(executable: string, profile: string, request: unknown, timeoutMs = 30000): Promise<unknown> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new HiveError(504, 'Bot request expired before execution; no operation was dispatched');
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 65536) throw new HiveError(400, 'Bot request exceeds 64 KiB');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot', 'WINDIR', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['invoke', '--home', profile], { cwd: profile, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let bytes = 0, settled = false;
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } };
    const fail = (message: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stop();
      // A detached descendant may retain inherited pipes. Do not wait for close
      // to release the request and update lock after the deadline/output limit.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      reject(new HiveError(502, message));
    };
    const timer = setTimeout(() => fail('Bot operation did not complete. Its outcome may be unknown; check status before retrying.'), Math.min(30000, Math.max(1, timeoutMs)));
    const consume = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 65536) fail('Bot operation did not complete. Its outcome may be unknown; check status before retrying.');
      else if (stdout) output.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => consume(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
    child.stdin.on('error', () => {});
    child.on('exit', stop);
    child.on('error', () => fail('Could not start the bot executable'));
    child.on('close', code => {
      if (settled) return;
      clearTimeout(timer);
      // Never expose executable error output: it can contain credentials. Never retry a mutation.
      if (code !== 0) return fail('Bot operation did not complete. Its outcome may be unknown; check status before retrying.');
      try { const result = JSON.parse(Buffer.concat(output).toString('utf8')); settled = true; resolve(result); }
      catch { fail('Invalid bot receipt. Check status before retrying.'); }
    });
    child.stdin.end(input);
  });
}
