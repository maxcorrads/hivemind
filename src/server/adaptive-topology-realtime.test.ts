import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { Hive } from './hive.ts';
import { startServer } from './serve.ts';
import { saveAdaptiveRouting } from './adaptive-routing.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import type { AdaptiveExecutionState, AdaptiveRoutingEvent, AdaptiveTopology } from '../shared/adaptive-topology.ts';

test('real authenticated Human websocket receives every routing check while agent context gets only applied policy', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-routing-realtime-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.getAgent('human');
  const brain = hive.join({ role: 'brain', project: 'chapter' });
  for (let i = 0; i < 2; i++) hive.join({ role: 'worker', seniority: 'senior', project: 'chapter' });
  const dm = hive.openDm(human, brain.agent.name);
  const server = startServer({ hive, port: 0, telegram: false });
  let socket: WebSocket | undefined;
  t.after(async () => {
    socket?.terminate(); await hive.adaptiveTopology.stop(); await server.shutdown();
    hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const nativeFetch = globalThis.fetch;
  let target: AdaptiveTopology = 'single', unavailable = false;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return nativeFetch(url, init);
    if (unavailable) throw new Error('Fixture unavailable');
    return Response.json(jevTopologyResponse(String(init?.body), target));
  });
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'not-a-live-key' });
  const base = `http://127.0.0.1:${await server.ready}`;
  const session = await fetch(`${base}/api/ui/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(session.status, 200); const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
  await session.arrayBuffer();
  socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { origin: base, cookie } });
  type Frame = { type: string; payload: { event: AdaptiveRoutingEvent; state: AdaptiveExecutionState; channelId: string } };
  const frames: Frame[] = [];
  socket.on('message', raw => frames.push(JSON.parse(String(raw)) as Frame));
  await once(socket, 'open');
  const nextRouting = () => new Promise<Frame>(resolve => {
    const listener = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.type === 'adaptive-routing') { socket!.off('message', listener); resolve(frame); }
    };
    socket!.on('message', listener);
  });
  let pending = nextRouting();
  const started = await hive.adaptiveTopology.routeHumanRequest(human, { channel: dm.id, body: 'Perform the bounded request.', requestId: 'start' }, 'auto', 'none');
  assert.ok(started); const initial = await pending; assert.equal(initial.payload.state.monitoring, 'active');
  const messagesBefore = Number(hive.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n);
  const checkpoint = (key: string) => hive.adaptiveTopology.revalidateForActor(brain.agent, {
    kind: 'brain_message', actorId: brain.agent.id, actorRole: 'brain', channelId: dm.id, eventId: key,
  });
  pending = nextRouting(); unavailable = true; await checkpoint('failure');
  const failed = await pending; assert.equal(failed.payload.event.kind, 'warning');
  assert.equal(failed.payload.state.currentTopology, 'single'); assert.equal(failed.payload.state.monitoring, 'unavailable');
  pending = nextRouting(); unavailable = false; target = 'brain_multi_room'; await checkpoint('recovery');
  const recovered = await pending; assert.equal(recovered.payload.event.kind, 'transition');
  assert.equal(recovered.payload.state.currentTopology, 'brain_multi_room'); assert.equal(recovered.payload.state.warning, null);
  assert.ok((recovered.payload.state.revision ?? 0) > (failed.payload.state.revision ?? 0));
  assert.equal(Number(hive.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n), messagesBefore);
  const agent = await fetch(`${base}/api/agent/me`, { headers: { authorization: `Bearer ${brain.token}` } });
  const policy = (await agent.json() as { adaptiveRouting: Record<string, unknown> }).adaptiveRouting;
  assert.equal(policy.currentTopology, 'brain_multi_room');
  assert.deepEqual(Object.keys(policy).sort(), ['currentTopology', 'delegationPaused', 'executionId', 'locked', 'workerBudget'].sort());
  const forbidden = await fetch(`${base}/api/ui/channels/${dm.id}/adaptive-routing`, { headers: { authorization: `Bearer ${brain.token}` } });
  assert.equal(forbidden.status, 401); await forbidden.arrayBuffer();
  pending = nextRouting();
  const disabled = await fetch(`${base}/api/ui/adaptive-routing`, { method: 'PUT', headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(disabled.status, 200); await disabled.arrayBuffer();
  assert.equal((await pending).payload.state.monitoring, 'disabled');
  const retained = await fetch(`${base}/api/ui/channels/${dm.id}/adaptive-routing`, { headers: { origin: base, cookie } });
  const view = await retained.json() as { state: AdaptiveExecutionState; events: AdaptiveRoutingEvent[] };
  assert.equal(view.state.monitoring, 'disabled'); assert.equal(view.events.length, 4);
  assert.equal(frames.filter(frame => frame.type === 'adaptive-routing').length, 4);
});
