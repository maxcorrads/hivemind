import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { JevLog } from './JevLog.tsx';
import { api } from './api.ts';
import { answerLabel, appendOlderPage, mergeRefreshedPage, outcomeLabel, questionRows, requestedModel, triggerLabel } from './jev-log-view.ts';
import type { JevCall, JevCallSummary, JevRequestGroup } from '../src/shared/jev-calls.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, location: window.location,
  HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

function summary(id: string, patch: Partial<JevCallSummary> = {}): JevCallSummary {
  return { id, routeId: `route-${id}`, projectId: 'p', channelId: 'dm', executionId: 'exec-1', brainId: 'brain-1', createdAt: 1_000,
    phase: 'initial', trigger: { kind: 'human_request', eventType: null }, request: 'Refactor the parser.', status: 'ok',
    targetTopology: 'brain_one_worker', targetWorkers: 1, confidence: 0.93, reason: 'one_worker_sufficient', error: null,
    model: 'jev-latest', latencyMs: 420, inputTokens: 900, outputTokens: 40,
    outcome: { kind: 'transition', applied: true, appliedTopology: 'brain_one_worker', appliedWorkers: 1, warning: null }, ...patch };
}
const sent = { model: 'jev-latest', state: { request: 'Refactor the parser.', current: null,
  capacity: { workers: { free: 2, busyCurrent: 0, busyOther: 1, online: 3, total: 3 } }, tasks: { active: 0, blockers: 0, openDependencies: 0 },
  execution: { lockedTopology: null, lockScope: 'none', orchestratedOnly: false } },
  questions: { single_agent_sufficiency: { type: 'choice' }, complexity: { type: 'score' }, target_topology: { type: 'choice' } } };
const received = { model: 'jev-latest', answers: {
  single_agent_sufficiency: { type: 'choice', choice: 'insufficient', confidence: 0.95, probabilities: { sufficient: 0.05, insufficient: 0.95 } },
  complexity: { type: 'score', score: 1.6, confidence: 0.93, probabilities: { 0: 0.05, 1: 0.25, 2: 0.7 } },
  target_topology: { type: 'choice', choice: 'brain_one_worker', confidence: 0.94, probabilities: { single: 0.03, brain_one_worker: 0.94, brain_multi_dm: 0.03 } },
} };

test('labels explain triggers, answers and outcomes in plain words', () => {
  assert.equal(triggerLabel({ kind: 'human_message', eventType: null }, 'continuous'), 'Your reply in the thread');
  assert.equal(triggerLabel({ kind: 'task_event', eventType: 'review' }, 'continuous'), 'Brain task update · review');
  assert.equal(answerLabel(summary('a')), 'Brain + 1 · 1 worker · 93%');
  assert.match(answerLabel(summary('b', { status: 'unavailable', error: 'timeout' })), /No answer · timeout/);
  assert.equal(outcomeLabel(summary('a')).tone, 'applied');
  assert.match(outcomeLabel(summary('c', { outcome: null })).text, /Not used/);
  assert.match(outcomeLabel(summary('d', { outcome: { kind: 'observation', applied: false, appliedTopology: 'single', appliedWorkers: 0, warning: null } })).text, /not enforced/);
  const rows = questionRows(sent, received);
  assert.deepEqual(rows.map(row => row.answer), ['No, delegation helps', 'High (1.60 / 2)', 'Brain + 1']);
  assert.equal(rows[1]!.options.find(option => option.chosen)?.label, 'High');
  assert.deepEqual(questionRows(sent, null).map(row => row.answer), ['No answer', 'No answer', 'No answer'], 'Malformed or missing answers never crash');
});

test('requested model comes from the summary, or from the exact sent payload for calls recorded before pinning', () => {
  const call: JevCall = { ...summary('a'), sent, received };
  assert.equal(requestedModel(call), 'jev-latest');
  assert.equal(requestedModel({ ...call, requestedModel: 'jev-2026-09-01' }), 'jev-2026-09-01');
  assert.equal(requestedModel({ ...call, requestedModel: null, sent: null }), null);
  assert.equal(requestedModel({ ...call, sent: null }), null);
});

test('the Routing log groups calls by request and shows the exact exchange of the selected call', async t => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const calls = [summary('first'), summary('second', { phase: 'continuous', trigger: { kind: 'brain_message', eventType: 'progress' }, createdAt: 2_000,
    outcome: { kind: 'evaluation', applied: false, appliedTopology: 'brain_one_worker', appliedWorkers: 1, warning: null } })];
  t.mock.method(api, 'jevCalls', async () => ({ hasMore: false, nextCursor: null, requests: [{ executionId: 'exec-1', channelId: 'dm', brainId: 'brain-1',
    request: 'Refactor the parser.', firstAt: 1_000, lastAt: 2_000, callCount: 2, calls }] }));
  const detail: JevCall = { ...calls[0]!, sent, received };
  t.mock.method(api, 'jevCall', async () => ({ call: detail }));
  let opened: string | null = null;
  await act(async () => root.render(<JevLog project="chapter" tick={0} channelLabel={() => 'Human, Atlas'}
    agentName={() => 'Atlas'} onOpenChannel={id => { opened = id; }} />));
  const text = () => host.textContent ?? '';
  assert.equal(host.querySelector('h1')?.textContent, 'Routing log');
  assert.match(text(), /Every request Hivemind sent to Jev \(TypeSafe\) and its answer\./);
  assert.match(text(), /1 request · 2 calls shown/);
  assert.match(text(), /Refactor the parser\./);
  assert.match(text(), /Your new request/);
  assert.match(text(), /Brain message · progress/);
  assert.match(text(), /Applied → Brain \+ 1/);
  assert.match(text(), /Mode confirmed · Brain \+ 1/);
  const call = Array.from(host.querySelectorAll('button.jev-call'))[0] as HTMLElement;
  await act(async () => call.click());
  assert.match(text(), /1 · Sent to Jev/);
  assert.match(text(), /2 free · 0 on this request · 1 busy elsewhere/);
  assert.match(text(), /Can the brain handle it alone\?/);
  assert.match(text(), /No, delegation helps/);
  assert.match(text(), /One worker is enough/);
  assert.match(text(), /Requested modeljev-latest/);
  assert.doesNotMatch(text(), /differs from requested/);
  assert.match(host.querySelector('pre')?.textContent ?? '', /"request": "Refactor the parser\."/);
  const channel = Array.from(host.querySelectorAll('.jev-request button.text-btn')).find(item => item.textContent === 'Human, Atlas') as HTMLElement;
  await act(async () => channel.click());
  assert.equal(opened, 'dm');
});

const group = (executionId: string, lastAt: number): JevRequestGroup => ({ executionId, channelId: 'dm', brainId: 'brain-1',
  request: `Request ${executionId}`, firstAt: lastAt, lastAt, callCount: 1, calls: [summary(executionId, { executionId, createdAt: lastAt })] });

test('Older requests pages with the server cursor and keeps requests that share the boundary millisecond', async t => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.mock.method(api, 'jevCalls', async (_project: string, cursor?: string | null) => cursor === '5000:tie-a'
    ? { requests: [group('tie-b', 5_000), group('old', 1_000)], hasMore: false, nextCursor: null }
    : { requests: [group('new', 9_000), group('tie-a', 5_000)], hasMore: true, nextCursor: '5000:tie-a' });
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<JevLog project="chapter" tick={0} channelLabel={() => 'dm'} agentName={() => 'Atlas'} onOpenChannel={() => {}} />));
  const more = [...host.querySelectorAll('button')].find(button => button.textContent === 'Older requests') as HTMLElement;
  assert.ok(more);
  await act(async () => more.click());
  const mock = (api.jevCalls as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock;
  assert.equal(mock.calls.at(-1)!.arguments[1], '5000:tie-a', 'The opaque nextCursor is sent back unchanged');
  assert.deepEqual([...host.querySelectorAll('.jev-request-text')].map(item => item.textContent),
    ['Request new', 'Request tie-a', 'Request tie-b', 'Request old']);
  assert.equal([...host.querySelectorAll('button')].some(button => button.textContent === 'Older requests'), false);
});

test('live refresh keeps loaded older pages and their cursor, ordered like the server', () => {
  const loaded = appendOlderPage({ requests: [group('a', 9_000), group('b', 5_000)], hasMore: true, nextCursor: '5000:b' },
    { requests: [group('c', 5_000), group('d', 1_000)], hasMore: true, nextCursor: '1000:d' });
  assert.deepEqual(loaded.requests.map(item => item.executionId), ['a', 'b', 'c', 'd']);
  // A new request arrives: the first page shifts by one and `b` is its new tail.
  const refreshed = mergeRefreshedPage(loaded, { requests: [group('z', 9_500), group('a', 9_000), group('b', 5_000)], hasMore: true, nextCursor: '5000:b' });
  assert.deepEqual(refreshed.requests.map(item => item.executionId), ['z', 'a', 'b', 'c', 'd'], 'Same-millisecond `c` is kept after `b`');
  assert.equal(refreshed.nextCursor, '1000:d', 'The cursor after the last loaded page is kept');
  const firstOnly = mergeRefreshedPage({ requests: [group('a', 9_000)], hasMore: false, nextCursor: null },
    { requests: [group('z', 9_500), group('a', 9_000)], hasMore: false, nextCursor: null });
  assert.deepEqual(firstOnly.requests.map(item => item.executionId), ['z', 'a']);
});
