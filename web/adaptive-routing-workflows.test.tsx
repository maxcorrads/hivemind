import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { useAdaptiveRouting } from './use-adaptive-routing.ts';
import { adviceStrip, mergeRoutingView } from './adaptive-routing-view.ts';
import { AdaptiveRoutingPanel, adviceSummary, routingEventLabel } from './AdaptiveRoutingPanel.tsx';
import { AdaptiveRoutingSettings } from './AdaptiveRoutingSettings.tsx';
import { RoutingStrip } from './ChannelDesk.tsx';
import { Composer } from './Composer.tsx';
import { api } from './api.ts';
import type { AdaptiveExecutionState, AdaptiveRoutingEvent, AdaptiveRoutingView, AdaptiveTopology,
  AdaptiveTopologyDecision } from '../src/shared/adaptive-topology.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, location: window.location,
  HTMLElement: window.HTMLElement, HTMLSelectElement: window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function decision(topology: AdaptiveTopology = 'brain_multi_dm', workers = 2, confidence: number | null = 0.72,
  extra: Partial<AdaptiveTopologyDecision> = {}): AdaptiveTopologyDecision {
  return { routeId: 'r', contractVersion: 'adaptive-routing-v3', targetTopology: topology, targetWorkers: workers, confidence,
    reason: 'parallel_workstreams', providerStatus: 'ok', model: 'fixture', latencyMs: 1, inputTokens: 1, outputTokens: 1,
    singleSufficient: false, needsOrchestration: true, ...extra };
}
function state(channelId = 'a', revision = 1, executionId = 'run-a', recommendation: AdaptiveTopologyDecision | null = decision()): AdaptiveExecutionState {
  return { executionId, channelId, projectId: 'project', brainId: 'brain', rootMessageId: 'root', recommendation,
    updatedAt: revision, revision, monitoring: 'active', completedAt: null };
}
function event(s: AdaptiveExecutionState, id = 'event', kind: AdaptiveRoutingEvent['kind'] = 'advice', trigger = 'brain_message'): AdaptiveRoutingEvent {
  return { id, executionId: s.executionId, channelId: s.channelId, projectId: s.projectId, createdAt: s.updatedAt, kind, trigger,
    targetTopology: 'brain_multi_dm', targetWorkers: 2, confidence: 0.72, reason: 'parallel_workstreams', providerStatus: 'ok' };
}
function view(s: AdaptiveExecutionState): AdaptiveRoutingView { return { state: s, events: [event(s, `e-${s.revision}`)] }; }
function mounted(t: TestContext) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const button = (label: string) => { const b = Array.from(host.querySelectorAll('button')).find(item => item.textContent === label); assert.ok(b, label); return b; };
  return { host, root, button, render: async (element: ReturnType<typeof createElement>) => { await act(async () => root.render(element)); } };
}

test('routing merge keeps each brain\'s latest request, bounds the audit and never crosses channels', () => {
  const latest = state('a', 10, 'new'), old = state('a', 2, 'old');
  assert.equal(mergeRoutingView(view(latest), view(old), 'a').state?.executionId, 'new');
  assert.equal(mergeRoutingView(view(latest), { state: null, events: [] }, 'a').state?.executionId, 'new');
  const foreign = state('b', 20);
  assert.equal(mergeRoutingView(view(latest), view(foreign), 'a').state?.channelId, 'a');
  assert.equal(mergeRoutingView(null, view(foreign), 'a').state, null);
  const sameTime = { ...latest, revision: 11, recommendation: decision('single', 0) };
  assert.equal(mergeRoutingView(view(latest), view(sameTime), 'a').state?.recommendation?.targetTopology, 'single');
  const events = Array.from({ length: 150 }, (_, i) => event({ ...latest, updatedAt: i }, `bounded-${i}`));
  assert.equal(mergeRoutingView(null, { state: latest, events }, 'a').events.length, 100);

  const a = { ...state('a', 5, 'run-a'), brainId: 'brain-a' }, b = { ...state('a', 7, 'run-b'), brainId: 'brain-b' };
  const merged = mergeRoutingView({ state: a, executions: [a], events: [] }, { state: b, events: [event(b, 'b-1')] }, 'a');
  assert.deepEqual(merged.executions?.map(item => item.executionId).sort(), ['run-a', 'run-b']);
  assert.equal(merged.state?.executionId, 'run-b', 'The most recently updated open request is primary');
  const replaced = mergeRoutingView(merged, { state: { ...a, executionId: 'run-a2', updatedAt: 9, revision: 9 }, events: [] }, 'a');
  assert.deepEqual(replaced.executions?.map(item => item.executionId).sort(), ['run-a2', 'run-b'], 'A new request replaces only its own brain');
  const completed = mergeRoutingView(replaced, { state: { ...b, updatedAt: 20, revision: 20, completedAt: 20 }, events: [] }, 'a');
  assert.equal(completed.state?.executionId, 'run-a2', 'An open request stays primary over a closed one');
  assert.deepEqual(adviceStrip(completed, 'a').brains, 1);
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
  await f.render(<Harness channel={null} />); assert.equal(currentView(), null);
});

test('advice labels say what Jev suggested or why there is no advice (#211)', () => {
  assert.equal(adviceSummary(decision()), 'Jev suggests: Multi-DM · 2 workers (72%)');
  assert.equal(adviceSummary(decision('single', 0, 0.9)), 'Jev suggests: Single (90%)');
  assert.equal(adviceSummary(decision('brain_one_worker', 1, 0.41)), 'Jev uncertain (41%) · Brain + 1');
  assert.equal(adviceSummary(decision('single', 0, 0.99, { incoherent: 'plan_vs_sufficiency' })), 'Jev uncertain (incoherent: plan contradicts sufficiency)');
  assert.equal(adviceSummary(decision('single', 0, null, { providerStatus: 'unavailable', model: null, inputTokens: null,
    reason: 'provider_timeout_preserve_current', error: 'timeout' })), 'Jev unavailable (timeout)');
  const s = state();
  assert.equal(routingEventLabel(event(s, 'x', 'advice', 'delegation_attempt')), 'Brain delegated · Jev suggested Multi-DM · 2 workers (72%)');
  assert.equal(routingEventLabel(event(s, 'x', 'advice', 'wait')), 'Brain received mail · Jev suggested Multi-DM · 2 workers (72%)');
  assert.match(routingEventLabel(event(s, 'x', 'observation', 'observation')), /^No single owning brain · .* · recorded only$/);
  assert.equal(routingEventLabel({ ...event(s, 'x', 'status'), reason: 'execution_completed' }), 'Hivemind · request closed · no more advice');
  assert.equal(routingEventLabel({ ...event(s, 'x', 'status'), reason: 'execution_expired' }), 'Hivemind · request closed after inactivity');
  for (const label of [routingEventLabel(event(s)), adviceSummary(decision())]) assert.doesNotMatch(label, /applied|fallback|lock|mode kept/i);
});

test('the Routing panel shows advice per brain and has no lock controls', async t => {
  const f = mounted(t); let closes = 0;
  const a = { ...state('a', 5, 'run-a', decision('single', 0, 0.9)), brainId: 'brain-a' }, b = { ...state('a', 7, 'run-b'), brainId: 'brain-b' };
  const observed = event(a, 'observed', 'observation', 'observation');
  await f.render(<AdaptiveRoutingPanel channelId="a" view={{ state: b, executions: [a, b], events: [event(a, 'a-1'), event(b, 'b-1'), observed] }}
    brainNames={{ 'brain-a': 'Ada', 'brain-b': 'Bea' }} onClose={() => { closes++; }} />);
  assert.match(f.host.textContent!, /Jev suggests: Multi-DM · 2 workers \(72%\)/);
  assert.match(f.host.textContent!, /never enforced/);
  assert.match(f.host.textContent!, /No single owning brain/);
  assert.equal(f.host.querySelector('select'), null, 'no topology or scope selector');
  assert.equal(f.host.textContent!.match(/lock/i), null, 'no lock wording');
  const tab = Array.from(f.host.querySelectorAll('[role="tab"]')).find(item => item.textContent === 'Ada') as HTMLElement | undefined;
  assert.ok(tab);
  await act(async () => tab.click());
  assert.match(f.host.textContent!, /Jev suggests: Single \(90%\)/);
  await act(async () => f.button('Close').click()); assert.equal(closes, 1);
  for (const monitoring of ['disabled', 'completed'] as const) {
    await f.render(<AdaptiveRoutingPanel channelId="a" view={view({ ...state(), monitoring, completedAt: monitoring === 'completed' ? 2 : null })} onClose={() => {}} />);
    assert.match(f.host.textContent!, monitoring === 'disabled' ? /Jev disabled · brains get no advice/ : /Request closed/);
  }
  await f.render(<AdaptiveRoutingPanel channelId="a" view={{ state: null, events: [] }} onClose={() => {}} />);
  assert.match(f.host.textContent!, /No request to a brain has been sent to Jev/);
});

test('the strip above the composer shows usable Jev advice only and opens the panel; the composer has no mode selector', async t => {
  const f = mounted(t); let opened = 0;
  const strip = (v: AdaptiveRoutingView) => <RoutingStrip view={v} channelId="a" brainNames={{ brain: 'Ada' }} onOpen={() => { opened++; }} />;
  await f.render(strip(view(state())));
  assert.equal(f.host.querySelector('.routing-strip')?.textContent, 'Jev suggests: Multi-DM · 2 workers (72%)Advisory only · the brain decides');
  assert.equal(f.host.querySelector('.routing-strip.warning'), null);
  await act(async () => f.button('Jev suggests: Multi-DM · 2 workers (72%)').click());
  assert.equal(opened, 1);
  const failed = state('a', 2, 'run-a', decision('single', 0, null, { providerStatus: 'unavailable', model: null, inputTokens: null,
    reason: 'provider_timeout_preserve_current', error: 'timeout' }));
  await f.render(strip(view({ ...failed, advice: { plan: null, topology: null, workers: null, confidence: null, state: 'unavailable',
    reason: 'timeout', at: 2, note: 'Advisory only — you decide; Human instructions take precedence.' } })));
  assert.equal(f.host.querySelector('.routing-strip'), null, 'a failed Jev call is shown in the Routing log only (#214)');
  await f.render(strip(view({ ...state(), monitoring: 'disabled' })));
  assert.equal(f.host.querySelector('.routing-strip'), null, 'nothing about Jev while it is disabled (#214)');
  await f.render(strip(view({ ...state(), recommendation: null, advice: null })));
  assert.equal(f.host.querySelector('.routing-strip'), null, 'nothing before Jev has advised');
  await f.render(strip(view({ ...state(), monitoring: 'completed', completedAt: 2 })));
  assert.match(f.host.querySelector('.routing-strip')?.textContent ?? '', /Request closed · no further advice$/);
  const second = { ...state('a', 3, 'run-b'), brainId: 'other' };
  await f.render(strip({ state: second, executions: [state(), second], events: [] }));
  assert.match(f.host.querySelector('.routing-strip')?.textContent ?? '', /· brain · 2 brains/);
  await f.render(strip({ state: null, executions: [], events: [] }));
  assert.equal(f.host.querySelector('.routing-strip'), null);

  await f.render(<Composer agents={[]} value="" onChange={() => {}} onSend={() => {}} placeholder="Message" />);
  assert.equal(f.host.querySelector('select, .composer-routing, .routing-mode, .routing-lock-mode'), null);
  assert.doesNotMatch(f.host.textContent!, /Auto · Jev|Brain \+ 1|Multi-DM|Orchestrated|Lock/);
});

test('settings save resets the secret input and refreshes the view without returning the key', async t => {
  const f = mounted(t); let saved = 0, notified = 0;
  const settings = { enabled: true, apiKeySet: true, apiKeyHint: '…1234', model: 'jev-latest', defaultModel: 'jev-latest', modelPinned: false };
  t.mock.method(api, 'adaptiveRouting', async () => settings);
  t.mock.method(api, 'saveAdaptiveRouting', async () => { saved++; return settings; });
  await f.render(<AdaptiveRoutingSettings onClose={() => {}} onSaved={() => { notified++; }} />);
  assert.equal(f.host.querySelector<HTMLInputElement>('input[type=password]')?.value, '');
  assert.match(f.host.textContent!, /never enforced/);
  assert.doesNotMatch(f.host.textContent!, /fallback|Orchestrated|\block/i);
  await act(async () => f.host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event));
  assert.equal(saved, 1); assert.equal(notified, 1); assert.equal(f.host.querySelector<HTMLInputElement>('input[type=password]')?.value, '');
});

test('settings explain alias vs pinned model, validate the identifier and can reset to the alias', async t => {
  const f = mounted(t); const bodies: unknown[] = [];
  const pinned = { enabled: false, apiKeySet: true, apiKeyHint: '…1234', model: 'jev-2026-09-01', defaultModel: 'jev-latest', modelPinned: true };
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
  assert.deepEqual(bodies, [{ enabled: false, model: null }]);
  assert.match(f.host.textContent!, /default alias/);
});
