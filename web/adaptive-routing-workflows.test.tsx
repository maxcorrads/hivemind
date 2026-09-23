import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { useAdaptiveRouting } from './use-adaptive-routing.ts';
import { mergeRoutingView, routingStreamEntries, routingStripCounts } from './adaptive-routing-view.ts';
import { AdaptiveRoutingPanel, routingEventLabel } from './AdaptiveRoutingPanel.tsx';
import { AdaptiveRoutingSettings } from './AdaptiveRoutingSettings.tsx';
import { RoutingStrip } from './ChannelDesk.tsx';
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
  const settings = { enabled: true, apiKeySet: true, apiKeyHint: '…1234', model: 'jev-latest', defaultModel: 'jev-latest', modelPinned: false, fallback: 'orchestrated' as const, topologyFallback: 'brain_one_worker' as const };
  t.mock.method(api, 'adaptiveRouting', async () => settings);
  t.mock.method(api, 'saveAdaptiveRouting', async () => { saved++; return settings; });
  await f.render(<AdaptiveRoutingSettings onClose={() => {}} onSaved={() => { notified++; }} />);
  assert.equal(f.host.querySelector<HTMLInputElement>('input[type=password]')?.value, '');
  await act(async () => f.host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event));
  assert.equal(saved, 1); assert.equal(notified, 1); assert.equal(f.host.querySelector<HTMLInputElement>('input[type=password]')?.value, '');
});

test('settings explain alias vs pinned model, validate the identifier and can reset to the alias', async t => {
  const f = mounted(t); const bodies: unknown[] = [];
  const pinned = { enabled: false, apiKeySet: true, apiKeyHint: '…1234', model: 'jev-2026-09-01', defaultModel: 'jev-latest', modelPinned: true,
    fallback: 'orchestrated' as const, topologyFallback: 'brain_one_worker' as const };
  t.mock.method(api, 'adaptiveRouting', async () => pinned);
  t.mock.method(api, 'saveAdaptiveRouting', async (body: unknown) => { bodies.push(body);
    return { ...pinned, model: 'jev-latest', modelPinned: false }; });
  await f.render(<AdaptiveRoutingSettings onClose={() => {}} />);
  const input = f.host.querySelector<HTMLInputElement>('input[placeholder^="jev-latest"]');
  assert.ok(input); assert.equal(input.value, 'jev-2026-09-01');
  assert.match(f.host.textContent!, /pinned identifier/);
  assert.match(f.host.textContent!, /may resolve to a different model over time/);
  assert.match(f.host.textContent!, /does not list models or prices/);
  assert.match(f.host.textContent!, /model jev-2026-09-01/, 'the connection test names the saved model it uses');
  assert.doesNotMatch(f.host.textContent!, /\$|USD|per token/i, 'no hard-coded price');
  const type = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
  });
  await type('https://evil.example/v1');
  assert.match(f.host.textContent!, /not a URL/);
  assert.equal(f.button('Save').disabled, true);
  await type('');
  assert.equal(f.button('Save').disabled, false);
  assert.match(f.host.textContent!, /Save pending changes before testing/);
  await act(async () => f.host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event));
  assert.deepEqual(bodies, [{ enabled: false, fallback: 'orchestrated', topologyFallback: 'brain_one_worker', model: null }]);
  assert.match(f.host.textContent!, /default alias/);
});

test('a channel keeps one execution per brain, shows observations and locks the selected brain', async t => {
  const a = { ...state('a', 5, 'run-a'), brainId: 'brain-a' }, b = { ...state('a', 7, 'run-b'), brainId: 'brain-b' };
  const merged = mergeRoutingView({ state: a, executions: [a], events: [] }, { state: b, events: [event(b, 'b-1')] }, 'a');
  assert.deepEqual(merged.executions?.map(item => item.executionId).sort(), ['run-a', 'run-b']);
  assert.equal(merged.state?.executionId, 'run-b', 'The most recently updated running execution is primary');
  const replaced = mergeRoutingView(merged, { state: { ...a, executionId: 'run-a2', updatedAt: 9, revision: 9 }, events: [] }, 'a');
  assert.deepEqual(replaced.executions?.map(item => item.executionId).sort(), ['run-a2', 'run-b'], 'A new request replaces only its own brain');
  const completed = mergeRoutingView(replaced, { state: { ...b, updatedAt: 20, revision: 20, completedAt: 20 }, events: [] }, 'a');
  assert.equal(completed.state?.executionId, 'run-a2', 'A running execution stays primary over a completed one');

  const observation = { ...event(a, 'observed', 'observation'), targetTopology: 'brain_one_worker' as const, targetWorkers: 1 };
  assert.match(routingEventLabel(observation), /no single owning brain/);
  assert.match(routingEventLabel(observation), /not enforced/);

  const f = mounted(t); const bodies: unknown[] = [];
  t.mock.method(api, 'setAdaptiveRoutingLock', (_channel: string, body: unknown) => { bodies.push(body); return new Promise<AdaptiveRoutingView>(() => {}); });
  await f.render(<AdaptiveRoutingPanel channelId="a" view={{ ...merged, events: [...merged.events, observation] }}
    brainNames={{ 'brain-a': 'Ada', 'brain-b': 'Bea' }} onChange={() => {}} onClose={() => {}} />);
  assert.match(f.host.textContent!, /no single owning brain/);
  const tab = Array.from(f.host.querySelectorAll('[role="tab"]')).find(item => item.textContent?.startsWith('Ada')) as HTMLElement | undefined;
  assert.ok(tab);
  await act(async () => tab.click());
  await act(async () => f.button('Apply lock').click());
  assert.equal((bodies[0] as { expectedExecutionId: string }).expectedExecutionId, 'run-a');
});

test('draining executions stay beside the current one: merge, realtime and a read-only panel list', async t => {
  const current = { ...state('a', 10, 'run-new'), current: true };
  const draining = { ...state('a', 12, 'run-old'), current: false, currentTopology: 'brain_one_worker' as const, workerBudget: 1,
    requestExcerpt: 'Refactor the importer', openWork: { tasks: 1, delegations: 2 } };
  const merged = mergeRoutingView(null, { state: current, executions: [draining, current], events: [] }, 'a');
  assert.equal(merged.state?.executionId, 'run-new', 'a more recently updated draining execution never becomes primary');
  assert.deepEqual(merged.executions?.map(item => [item.executionId, item.current]).sort(), [['run-new', true], ['run-old', false]]);
  assert.deepEqual(routingStripCounts(merged, 'a'), { brains: 1, finishing: 1 });

  // A realtime update of the draining execution does not replace the current one.
  const update = { ...draining, updatedAt: 15, revision: 15, openWork: { tasks: 0, delegations: 1 } };
  const live = mergeRoutingView(merged, { state: update, events: [event(update, 'drain-1', 'status')] }, 'a');
  assert.equal(live.state?.executionId, 'run-new');
  assert.deepEqual(live.executions?.find(item => item.executionId === 'run-old')?.openWork, { tasks: 0, delegations: 1 });
  // A stale snapshot listing the old execution as current does not revive it.
  const stale = mergeRoutingView(live, { state: { ...draining, current: true, updatedAt: 1, revision: 1 }, events: [] }, 'a');
  assert.equal(stale.state?.executionId, 'run-new');
  assert.equal(stale.executions?.find(item => item.executionId === 'run-old')?.current, false);
  // A newer current execution for the same brain replaces the older current one, not the draining one.
  const third = { ...state('a', 20, 'run-third'), current: true };
  const replaced = mergeRoutingView(stale, { state: third, events: [] }, 'a');
  assert.deepEqual(replaced.executions?.map(item => item.executionId).sort(), ['run-old', 'run-third']);
  const finished = mergeRoutingView(replaced, { state: { ...update, updatedAt: 25, revision: 25, completedAt: 25, openWork: undefined }, events: [] }, 'a');
  assert.deepEqual(routingStripCounts(finished, 'a'), { brains: 1, finishing: 0 });
  assert.equal(finished.state?.executionId, 'run-third');
  assert.deepEqual(finished.executions?.map(item => item.executionId), ['run-third'], 'a completed draining execution is dropped');

  const f = mounted(t); const bodies: unknown[] = [];
  t.mock.method(api, 'setAdaptiveRoutingLock', (_channel: string, body: unknown) => { bodies.push(body); return new Promise<AdaptiveRoutingView>(() => {}); });
  await f.render(<AdaptiveRoutingPanel channelId="a" view={live} onChange={() => {}} onClose={() => {}} />);
  const section = f.host.querySelector('[aria-label="Still finishing"]');
  assert.ok(section, 'the draining list renders');
  assert.match(section.textContent!, /Refactor the importer/);
  assert.match(section.textContent!, /Brain \+ 1 · 1 worker · 1 delegation open/);
  assert.equal(section.querySelectorAll('button, select, input').length, 0, 'the draining list is read-only');
  assert.equal(f.host.querySelectorAll('[role="tab"]').length, 0, 'draining executions are not lock targets');
  await act(async () => f.button('Apply lock').click());
  assert.equal((bodies[0] as { expectedExecutionId: string }).expectedExecutionId, 'run-new');
  await f.render(<AdaptiveRoutingPanel channelId="a" view={finished} onChange={() => {}} onClose={() => {}} />);
  assert.equal(f.host.querySelector('[aria-label="Still finishing"]'), null, 'a drained execution leaves the list');
});

test('a drained execution stays dropped: its completion event fences a delayed snapshot', () => {
  const current = { ...state('a', 10, 'run-new'), current: true };
  const draining = { ...state('a', 8, 'run-old'), current: false, openWork: { tasks: 1, delegations: 0 } };
  const merged = mergeRoutingView(null, { state: current, executions: [draining, current], events: [] }, 'a');
  assert.deepEqual(routingStripCounts(merged, 'a'), { brains: 1, finishing: 1 });
  // Realtime: the server completes the drained execution and publishes it with its status event.
  const done = { ...draining, updatedAt: 12, revision: 12, completedAt: 12, openWork: undefined };
  const drained = mergeRoutingView(merged, { state: done, events: [{ ...event(done, 'drained', 'status'), reason: 'delegated_work_drained' }] }, 'a');
  assert.deepEqual(drained.executions?.map(item => item.executionId), ['run-new']);
  assert.deepEqual(routingStripCounts(drained, 'a'), { brains: 1, finishing: 0 });
  // A delayed HTTP snapshot from before the completion does not bring it back.
  const delayed = mergeRoutingView(drained, { state: current, executions: [draining, current], events: [] }, 'a');
  assert.deepEqual(delayed.executions?.map(item => item.executionId), ['run-new']);
  // A Human closing the request completes a draining execution the same way.
  const closed = { ...draining, updatedAt: 9, revision: 9, completedAt: 9 };
  const other = { ...state('a', 7, 'run-closed'), current: false };
  const withOther = mergeRoutingView(delayed, { state: current, executions: [other, current], events: [] }, 'a');
  assert.deepEqual(routingStripCounts(withOther, 'a'), { brains: 1, finishing: 1 });
  const closedView = mergeRoutingView(withOther, { state: null,
    events: [{ ...event({ ...closed, executionId: 'run-closed' }, 'closed', 'status'), reason: 'execution_completed' }] }, 'a');
  assert.deepEqual(routingStripCounts(closedView, 'a'), { brains: 1, finishing: 0 });
});

test('the routing strip shows older requests finishing even without a current execution', async t => {
  const f = mounted(t); let opened = 0;
  const draining = { ...state('a', 8, 'run-old'), current: false, openWork: { tasks: 1, delegations: 0 } };
  const view = mergeRoutingView(null, { state: null, executions: [draining], events: [] }, 'a');
  assert.equal(view.state, null);
  const counts = routingStripCounts(view, 'a');
  assert.deepEqual(counts, { brains: 0, finishing: 1 });
  const strip = (v: AdaptiveRoutingView, finishing: number) => <RoutingStrip view={v} channelId="a" activeExecutions={0}
    finishingExecutions={finishing} brainNames={{}} onOpen={() => { opened++; }} />;
  await f.render(strip(view, counts.finishing));
  assert.match(f.host.querySelector('.routing-strip')?.textContent ?? '', /\+1 finishing.*Earlier requests are finishing/);
  await act(async () => f.button('+1 finishing').click());
  assert.equal(opened, 1, 'the strip opens the routing panel');
  // With a current execution the count follows its summary; with nothing left the strip disappears.
  const current = { ...state('a', 10, 'run-new'), current: true };
  await f.render(strip({ state: current, executions: [draining, current], events: [] }, 1));
  assert.match(f.host.querySelector('.routing-strip')?.textContent ?? '', /^Single · \+1 finishing/);
  await f.render(strip({ state: null, executions: [], events: [] }, 0));
  assert.equal(f.host.querySelector('.routing-strip'), null);
});
