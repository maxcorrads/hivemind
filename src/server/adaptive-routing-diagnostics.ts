import { statSync } from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import type { DiagnosticsDeps } from './services/ports.ts';
import { HiveError } from '../shared/types.ts';
import { CREDENTIAL_JSON_BYTES, readLimitedJson } from './ingress.ts';
import { loadAdaptiveRouting, TYPESAFE_ENDPOINT, TYPESAFE_MODEL } from './adaptive-config.ts';
import { JevConnectionDiagnostics } from './jev-diagnostics.ts';

/** Mount only after the local Human UI middleware; the serving layer also authenticates the Human session. */
export function installJevDiagnostics(ui: Hono, deps: DiagnosticsDeps, fetchImpl: typeof fetch = fetch): JevConnectionDiagnostics {
  const diagnostics = new JevConnectionDiagnostics(() => {
    try {
      const config = loadAdaptiveRouting(deps.home);
      let stamp = 'absent';
      if (config) {
        const stat = statSync(path.join(deps.home, 'adaptive-routing.json'), { bigint: true });
        stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      }
      return { apiKey: config?.apiKey ?? '', model: config?.model ?? TYPESAFE_MODEL, configuration: { config, stamp } };
    } catch {
      // A failed configuration read cannot establish a successful test or expose a filesystem error.
      return { apiKey: '', model: TYPESAFE_MODEL, configuration: 'unavailable' };
    }
  }, (apiKey, body, signal) => fetchImpl(TYPESAFE_ENDPOINT, {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body,
  }));
  ui.get('/adaptive-routing/connection-test', c => {
    deps.identity.getAgent('human');
    return c.json(diagnostics.state());
  });
  ui.post('/adaptive-routing/connection-test', async c => {
    deps.identity.getAgent('human');
    const body = await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !('revision' in body) ||
        typeof body.revision !== 'string' || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/.test(body.revision))
      throw new HiveError(400, 'Expected the saved diagnostic revision');
    return c.json(await diagnostics.test(body.revision, c.req.raw.signal));
  });
  return diagnostics;
}
