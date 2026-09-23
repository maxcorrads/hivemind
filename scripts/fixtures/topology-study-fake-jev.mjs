// Preload for #136 host tests: the isolated trial server answers TypeSafe from a local fixture and cannot reach any
// non-loopback host. FAKE_JEV_TARGET picks the topology; FAKE_JEV_MODEL overrides the resolved model (drift tests);
// FAKE_JEV_CRASH=1 kills the server mid-request (lost-response tests).
import { jevTopologyResponse } from '../../src/server/fixtures/jev-topology.ts';

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (url.hostname === 'api.typesafe.ai') {
    // Simulates the server dying while the Human request waits for classification: the client loses the response.
    if (process.env.FAKE_JEV_CRASH === '1') process.kill(process.pid, 'SIGKILL');
    const response = jevTopologyResponse(String(init?.body), process.env.FAKE_JEV_TARGET ?? 'brain_one_worker');
    if (process.env.FAKE_JEV_MODEL) response.model = process.env.FAKE_JEV_MODEL;
    return Response.json(response);
  }
  if (!loopback.has(url.hostname)) throw new Error(`Network disabled in the fake trial server: ${url.hostname}`);
  return realFetch(input, init);
};
