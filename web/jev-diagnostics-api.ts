import { humanSession } from './human-session.ts';
import { JEV_DIAGNOSTIC_MESSAGES, type JevDiagnosticResult, type JevDiagnosticState } from '../src/shared/jev-diagnostics.ts';

async function request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await humanSession.request(path, init);
  // Deliberately never propagate a response body or exception message into diagnostic UI.
  if (!response.ok) throw new Error('Could not complete the local connection test.');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid diagnostic response.');
  return value as Record<string, unknown>;
}
function revision(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/.test(value);
}
const endpoint = '/api/ui/adaptive-routing/connection-test';
export const jevDiagnosticsApi = {
  async state(signal?: AbortSignal): Promise<JevDiagnosticState> {
    const value = await request(endpoint, { signal });
    if (!revision(value.revision) || typeof value.apiKeySet !== 'boolean') throw new Error('Invalid diagnostic state.');
    return { revision: value.revision, apiKeySet: value.apiKeySet };
  },
  async test(savedRevision: string, signal?: AbortSignal): Promise<JevDiagnosticResult> {
    const value = await request(endpoint, { method: 'POST', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: savedRevision }) });
    if (!revision(value.revision) || typeof value.code !== 'string' || !Object.hasOwn(JEV_DIAGNOSTIC_MESSAGES, value.code))
      throw new Error('Invalid diagnostic result.');
    return { revision: value.revision, code: value.code as JevDiagnosticResult['code'] };
  },
};
