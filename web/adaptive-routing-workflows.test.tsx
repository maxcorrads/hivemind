import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { useAdaptiveRouting } from './use-adaptive-routing.ts';
import { mergeRoutingView, routingStreamEntries } from './adaptive-routing-view.ts';
import { AdaptiveRoutingPanel, routingEventLabel } from './AdaptiveRoutingPanel.tsx';
import { AdaptiveRoutingSettings } from './AdaptiveRoutingSettings.tsx';
import { api } from './api.ts';
import type { AdaptiveExecutionState, AdaptiveRoutingEvent, AdaptiveRoutingView } from '../src/shared/adaptive-topology.ts';
import type { Message } from '../src/shared/types.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, location: window.location,
  HTMLElement: window.HTMLElement, HTMLSelectElement: window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function state(channelId = 'a', revision = 1, executionId = 'run-a'): AdaptiveExecutionState {
  return { executionId, channelId, projectId: 'project', brainId: 'brain', rootMessageId: 'root', currentTopology: 'single', workerBudget: 0,
    desiredTopology: null, desiredWorkers: null, lockScope: 'none', lockedTopology: null, orchestratedOnly: false,
    providerAvailable: true, warning: null, recommendation: null, confirmations: 0, confirmationTopology: null,
    confirmationWorkers: null, eventsSinceChange: 2, updatedAt: revision, revision, monitoring: 'active' };
}
function event(s: AdaptiveExecutionState, id = 'event', kind: AdaptiveRoutingEvent['kind'] = 'evaluation'): AdaptiveRoutingEvent {
  return { id, executionId: s.executionId, channelId: s.channelId, projectId: s.projectId, createdAt: s.updatedAt, kind,
    fromTopology: 'single', targetTopology: s.currentTopology, appliedTopology: s.currentTopology,
    targetWorkers: s.workerBudget, appliedWorkers: s.workerBudget, confidence: 0.95, reason: 'fixture',
    providerStatus: 'ok', applied: kind === 'transition', warning: null };
}
function view(s: AdaptiveExecutionState): AdaptiveRoutingView { return { state: s, events: [event(s, `e-${s.revision}`)] }; }
function mounted(t: TestContext) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const button = (label: string) => { const b = Array.from(host.querySelectorAll('button')).find(item => item.textContent === label); assert.ok(b, label); return b; };
  return { host, root, button, render: async (element: ReturnType<typeof createElement>) => { await act(async () => root.render(element)); } };
}

test('routing merge retains the latest state, bounds audit and never crosses channels', () => {
  const latest = state('a', 10, 'new'), old = state('a', 2, 'old');
  assert.equal(mergeRoutingView(view(latest), view(old), 'a').state?.executionId, 'new');
  assert.equal(mergeRoutingView(view(latest), { state: null, events: [] }, 'a').state?.executionId, 'new');
  const foreign = state('b', 20);
  assert.equal(mergeRoutingView(view(latest), view(foreign), 'a').state?.channelId, 'a');
  assert.equal(mergeRoutingView(null, view(foreign), 'a').state, null);
  const sameTime = { ...latest, revision: 11, currentTopology: 'brain_one_worker' as const, workerBudget: 1 };
  assert.equal(mergeRoutingView(view(latest), view(sameTime), 'a').state?.workerBudget, 1);
  const events = Array.from({ length: 150 }, (_, i) => event({ ...latest, updatedAt: i }, `bounded-${i}`));
  const merged = mergeRoutingView(null, { state: latest, events }, 'a'); assert.equal(merged.events.length, 100);
  const original: Message = { id: 'mail', seq: 1, channelId: 'a', threadId: null, authorId: 'human', authorName: 'Human', authorRole: 'human',
    body: 'Unmodified mail', kind: 'chat', control: null, mentions: [], createdAt: 3 };
  const entries = routingStreamEntries([original], [event(latest, 'keep'), event(old, 'too-old', 'transition'),
    event(latest, 'change', 'transition'), { ...event(latest, 'lock', 'lock'), applied: true }, event(foreign, 'other', 'transition')], 'a');
  assert.deepEqual(entries.map(e => e.kind), ['message', 'routing', 'routing']); assert.equal(entries[0]!.kind === 'message' && entries[0]!.message, original);
});

test('hook fences old HTTP by channel and merges realtime ahead of a delayed snapshot', async t => {
  const f = mounted(t); const requests: Array<ReturnType<typeof deferred<AdaptiveRoutingView>> & { channel: string; signal?: AbortSignal }> = [];
  t.mock.method(api, 'adaptiveRoutingView', (channel: string, signal?: AbortSignal) => {
    const item = { ...deferred<AdaptiveRoutingView>(), channel, signal }; requests.push(item); return item.promise;
  });
  let controller!: ReturnType<typeof useAdaptiveRouting>;
  const currentView = () => controller.view;
  function Harness({ channel }: { channel: string | null }) { controller = useAdaptiveRouting(channel); return <div>{currentView()?.state?.executionId ?? 'empty'}</div>; }
  await f.render(<Harness channel="a" />); const a = requests[0]!;
  const live = state('a', 20, 'live'); await act(async () => controller.onEvent({ channelId: 'a', state: live, event: event(live) }));
  await act(async () => a.resolve(view(state('a', 1, 'stale')))); assert.equal(currentView()?.state?.executionId, 'live');
  await f.render(<Harness channel="b" />); assert.equal(currentView(), null); const b = requests.at(-1)!;
  await act(async () => controller.onEvent({ channelId: 'a', state: state('a', 100), event: event(state('a', 100)) })); assert.equal(currentView(), null);
  await f.render(<Harness channel="a" />); assert.equal(b.signal?.aborted, true);
  await act(async () => b.resolve(view(state('b', 99, 'foreign')))); assert.equal(currentView(), null);
  await act(async () => requests.at(-1)!.resolve(view(state('a', 30, 'newest')))); assert.equal(currentView()?.state?.executionId, 'newest');
  await act(async () => controller.onEvent({ channelId: 'a', state: state('b', 999), event: event(state('a', 999)) })); assert.equal(currentView()?.state?.executionId, 'newest');
  await act(async () => controller.refresh(true)); assert.equal(currentView(), null);
  const reconnect = requests.at(-1)!; await act(async () => reconnect.reject(new Error('offline'))); assert.equal(controller.error, 'offline');
  await act(async () => controller.refresh()); await act(async () => requests.at(-1)!.resolve(view(state('a', 31, 'recovered'))));
  assert.equal(controller.error, null); assert.equal(currentView()?.state?.executionId, 'recovered');
  await act(async () => controller.onChange(view(state('a', 32, 'locked')))); assert.equal(currentView()?.state?.executionId, 'locked');
  await f.render(<Harness channel={null} />); assert.equal(currentView(), null);
});

test('panel sends execution/revision fences and ignores a response from an unmounted old execution', async t => {
  const f = mounted(t); const requests: Array<{ channel: string; body: unknown; reply: ReturnType<typeof deferred<AdaptiveRoutingView>> }> = [];
  t.mock.method(api, 'setAdaptiveRoutingLock', (channel: string, body: unknown) => { const reply = deferred<AdaptiveRoutingView>(); requests.push({ channel, body, reply }); return reply.promise; });
  let changes = 0, closes = 0;
  const props = { channelId: 'a', onChange: () => { changes++; }, onClose: () => { closes++; } };
  await f.render(<AdaptiveRoutingPanel {...props} view={view(state())} />);
  await act(async () => f.button('Apply lock').click());
  assert.deepEqual(requests[0]!.body, { scope: 'task', topology: 'single', expectedExecutionId: 'run-a', expectedRevision: 1 });
  assert.equal(f.button('Close').disabled, true);
  await f.render(<AdaptiveRoutingPanel {...props} view={view(state('a', 2, 'new-execution'))} />);
  await act(async () => requests[0]!.reply.resolve(view(state('a', 3, 'run-a')))); assert.equal(changes, 0);
  await act(async () => f.button('Apply lock').click()); await act(async () => requests[1]!.reply.reject(new Error('Routing changed')));
  assert.match(f.host.textContent!, /Routing changed/); assert.equal(f.button('Apply lock').disabled, false);
  await act(async () => f.button('Apply lock').click()); await act(async () => requests[2]!.reply.resolve(view(state('a', 4, 'new-execution')))); assert.equal(changes, 1);
  await act(async () => f.button('Close').click()); assert.equal(closes, 1);
});

test('panel labels disabled, pending, manual, locked, warning and completed states without suggesting live monitoring', async t => {
  const f = mounted(t); const props = { channelId: 'a', onChange: () => {}, onClose: () => {} };
  await f.render(<AdaptiveRoutingPanel {...props} view={{ state: null, events: [] }} />); assert.match(f.host.textContent!, /No adaptive execution/);
  for (const monitoring of ['disabled', 'pending', 'completed'] as const) {
    const current = { ...state(), monitoring, completedAt: monitoring === 'completed' ? 2 : null };
    await f.render(<AdaptiveRoutingPanel {...props} view={view(current)} />);
    assert.match(f.host.textContent!, monitoring === 'disabled' ? /disabled/ : monitoring === 'pending' ? /next coordination/ : /completed/);
  }
  const current = { ...state(), currentTopology: 'brain_multi_room' as const, workerBudget: 3,
    lockedTopology: 'brain_multi_room' as const, lockScope: 'conversation' as const,
    desiredTopology: 'single' as const, warning: 'Jev unavailable', recommendation: {
      routeId: 'r', contractVersion: 'adaptive-routing-v2' as const, targetTopology: 'brain_one_worker' as const, targetWorkers: 1,
      confidence: 0.95, reason: 'fixture', providerStatus: 'ok' as const, model: 'fixture', latencyMs: 1,
      inputTokens: 1, outputTokens: 1, singleSufficient: false, needsOrchestration: true,
    } };
  await f.render(<AdaptiveRoutingPanel {...props} view={view(current)} />);
  assert.match(f.host.textContent!, /recommendation only/); assert.match(f.host.textContent!, /3 workers/); assert.match(f.host.textContent!, /pending/);
  for (const topology of ['single', 'brain_one_worker', 'brain_multi_dm', 'brain_multi_room'] as const) {
    for (const kind of ['transition', 'warning', 'lock', 'evaluation', 'status'] as const) {
      const item = { ...event({ ...state(), currentTopology: topology, workerBudget: 1 }, 'test', kind), confidence: null };
      assert.ok(routingEventLabel(item).length);
      assert.match(routingEventLabel({ ...item, kind: 'evaluation', providerStatus: 'bypassed' }), /Manual/);
    }
  }
});

test('settings save resets the secret input and refreshes monitoring without returning the key', async t => {
  const f = mounted(t); let saved = 0, notified = 0;
  const settings = { enabled: true, apiKeySet: true, apiKeyHint: '…1234', model: 'jev-latest', fallback: 'orchestrated' as const, topologyFallback: 'brain_one_worker' as const };
  t.mock.method(api, 'adaptiveRouting', async () => settings);
  t.mock.method(api, 'saveAdaptiveRouting', async () => { saved++; return settings; });
  await f.render(<AdaptiveRoutingSettings onClose={() => {}} onSaved={() => { notified++; }} />);
  assert.equal(f.host.querySelector<HTMLInputElement>('input[type=password]')?.value, '');
  await act(async () => f.host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event));
  assert.equal(saved, 1); assert.equal(notified, 1); assert.equal(f.host.querySelector<HTMLInputElement>('input[type=password]')?.value, '');
});
