import { randomUUID } from 'node:crypto';
import type { JevDiagnosticCode, JevDiagnosticResult, JevDiagnosticState } from '../shared/jev-diagnostics.ts';

export type JevDiagnosticSettings = {
  apiKey: string;
  model: string;
  /** Private comparison material, including non-key settings and file identity. Never exported. */
  configuration: unknown;
};
export type JevDiagnosticTransport = (apiKey: string, body: string, signal: AbortSignal) => Promise<Response>;
const MAX_RESPONSE_BYTES = 16 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validResponse(value: unknown): boolean {
  if (!record(value) || typeof value.model !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value.model) ||
      !record(value.answers) || !record(value.answers.connection_check) || !record(value.usage)) return false;
  const answer = value.answers.connection_check;
  return answer.type === 'noul' && typeof answer.noul === 'number' && Number.isFinite(answer.noul) &&
    answer.noul >= 0 && answer.noul <= 1 &&
    Number.isSafeInteger(value.usage.input_tokens) && Number(value.usage.input_tokens) >= 0 &&
    Number.isSafeInteger(value.usage.output_tokens) && Number(value.usage.output_tokens) >= 0;
}
function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** Explicit synthetic probe only. The host supplies the fixed-endpoint transport, never an HTTP caller. */
export async function probeJevConnection(
  settings: Pick<JevDiagnosticSettings, 'apiKey' | 'model'>,
  send: JevDiagnosticTransport,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<JevDiagnosticCode> {
  if (!settings.apiKey) return 'missing_key';
  if (options.signal?.aborted) return 'cancelled';
  const timeoutMs = options.timeoutMs ?? 3_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw new RangeError('Invalid diagnostic timeout');
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<JevDiagnosticCode>(resolve => {
    onAbort = () => resolve(timeout.signal.aborted ? 'timeout' : 'cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const attempt = (async (): Promise<JevDiagnosticCode> => {
    let phase: 'network' | 'contract' = 'network';
    try {
      const body = JSON.stringify({
        model: settings.model,
        state: 'Hivemind synthetic connection check. No project data.',
        questions: { connection_check: {
          type: 'noul', instructions: 'Does this state describe a synthetic connection check?',
        } },
      });
      const response = await send(settings.apiKey, body, signal);
      // A transport can resolve after cancellation. Do not retain or parse that response.
      if (signal.aborted) { discard(response); return 'cancelled'; }
      if (!response.ok) {
        discard(response);
        if (response.status === 401 || response.status === 403) return 'authorization_failed';
        if (response.status === 429) return 'rate_limited';
        return 'provider_error';
      }
      phase = 'contract';
      if (!response.body) return 'invalid_contract';
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) return 'invalid_contract';
        chunks.push(part.value);
      }
      signal.throwIfAborted();
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return validResponse(value) ? 'success' : 'invalid_contract';
    } catch {
      // No exception message, raw body, endpoint credentials or provider identifier crosses this boundary.
      if (signal.aborted) return timeout.signal.aborted ? 'timeout' : 'cancelled';
      return phase === 'network' ? 'network_error' : 'invalid_contract';
    }
  })();
  try {
    // Bound even injected/non-cooperative transports and stalled response streams.
    return await Promise.race([attempt, aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

/** Per-app, bounded and ephemeral. No diagnostics enter agent messages or routing evidence. */
export class JevConnectionDiagnostics {
  private revision = randomUUID();
  private fingerprint: string | undefined;
  private active: AbortController | null = null;
  constructor(
    private readonly readSettings: () => JevDiagnosticSettings,
    private readonly send: JevDiagnosticTransport,
    private readonly timeoutMs = 3_000,
  ) {}

  settingsChanged(): void {
    this.revision = randomUUID(); // Opaque revision, not a key hash or suffix.
    this.active?.abort();
  }

  private synchronize(): JevDiagnosticSettings {
    const settings = this.readSettings();
    const fingerprint = JSON.stringify(settings);
    if (this.fingerprint !== undefined && this.fingerprint !== fingerprint) this.settingsChanged();
    this.fingerprint = fingerprint;
    return settings;
  }

  state(): JevDiagnosticState {
    const settings = this.synchronize();
    return { revision: this.revision, apiKeySet: Boolean(settings.apiKey) };
  }

  async test(expectedRevision: string, signal?: AbortSignal): Promise<JevDiagnosticResult> {
    const settings = this.synchronize();
    const revision = this.revision;
    if (expectedRevision !== revision) return { revision, code: 'settings_changed' };
    if (this.active) return { revision, code: 'busy' };
    const controller = new AbortController();
    this.active = controller;
    try {
      const code = await probeJevConnection(settings, this.send, {
        timeoutMs: this.timeoutMs,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      this.synchronize();
      return { revision, code: this.revision === revision ? code : 'settings_changed' };
    } finally {
      if (this.active === controller) this.active = null;
    }
  }
}
