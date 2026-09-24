import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { JevLog } from './JevLog.tsx';
import { api } from './api.ts';
import { answerLabel, appendOlderPage, errorLabel, mergeRefreshedPage, modelLabel, outcomeLabel, questionRows, reasonLabel, requestedModel, triggerLabel } from './jev-log-view.ts';
import { routingEventLabel } from './AdaptiveRoutingPanel.tsx';
import type { JevCall, JevCallSummary, JevRequestGroup } from '../src/shared/jev-calls.ts';
import type { AdaptiveRoutingEvent } from '../src/shared/adaptive-topology.ts';

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
    model: 'jev-latest', latencyMs: 420, inputTokens: 900, outputTokens: 40, outcome: null, ...patch };
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
  const noAnswer = { status: 'unavailable' as const, model: null, inputTokens: null, outputTokens: null, reason: 'provider_timeout_preserve_current' };
  assert.equal(answerLabel(summary('b', { ...noAnswer, error: 'timeout' })), 'No answer · Jev did not answer in time');
  assert.equal(answerLabel(summary('b', { ...noAnswer, error: 'Invalid Jev response' })), 'No answer · Invalid Jev response', 'Calls logged before #207 keep their text');
  assert.equal(answerLabel(summary('b', { status: 'unavailable', error: 'plan_not_offered', reason: 'response_rejected' })),
    'Answer rejected · Jev chose a plan that was not offered');
  assert.equal(answerLabel(summary('b', { status: 'unavailable', error: 'plan_not_offered', reason: 'response_rejected_preserve_current' })),
    'Answer rejected · Jev chose a plan that was not offered', 'Calls logged before #214 keep their old reason name');
  // #214 renamed the failure reasons; rows recorded earlier read the same.
  for (const [current, legacy, label] of [['provider_timeout', 'provider_timeout_preserve_current', 'Jev timed out'],
    ['provider_unavailable', 'provider_unavailable_preserve_current', 'Jev unavailable'],
    ['response_rejected', 'response_rejected_preserve_current', 'Jev answer rejected']]) {
    assert.equal(reasonLabel(current!), label); assert.equal(reasonLabel(legacy!), label);
  }
  assert.equal(triggerLabel({ kind: 'wait', eventType: null }, 'continuous'), 'Brain received mail');
  assert.equal(triggerLabel({ kind: 'thread_status', eventType: 'done' }, 'continuous'), 'Brain set a thread status · done');
  assert.deepEqual(outcomeLabel(summary('a')), { text: 'Advice returned to the brain · not enforced', tone: 'applied' });
  assert.equal(outcomeLabel(summary('low', { confidence: 0.2 })).text, 'Uncertain advice returned to the brain');
  assert.equal(outcomeLabel(summary('b', { status: 'unavailable', confidence: null, model: null, inputTokens: null, error: 'timeout',
    reason: 'provider_timeout_preserve_current' })).text, 'No advice delivered to the brain');
  assert.match(outcomeLabel(summary('o', { phase: 'observation' })).text, /Recorded only · no single owning brain/);
  // Calls recorded before #211 keep what was enforced then.
  assert.equal(outcomeLabel(summary('c', { outcome: { kind: 'transition', applied: true, appliedTopology: 'brain_one_worker', appliedWorkers: 1, warning: null } })).text,
    'Before #211: applied Brain + 1 · 1 worker');
  assert.match(outcomeLabel(summary('d', { outcome: { kind: 'observation', applied: false, appliedTopology: 'single', appliedWorkers: 0, warning: null } })).text, /not enforced/);
  const rows = questionRows(sent, received);
  assert.deepEqual(rows.map(row => row.answer), ['No, delegation helps', 'High (1.60 / 2)', 'Brain + 1']);
  assert.equal(rows[1]!.options.find(option => option.chosen)?.label, 'High');
  assert.deepEqual(questionRows(sent, null).map(row => row.answer), ['No answer', 'No answer', 'No answer'], 'Malformed or missing answers never crash');
});

test('every rejection reason reads in plain words', () => {
  assert.equal(errorLabel('plan_not_offered'), 'Jev chose a plan that was not offered');
  assert.equal(errorLabel('plan_contradicts_sufficiency'), 'Jev chose Single while saying the brain alone is not enough');
  assert.equal(errorLabel('malformed_answer:plan'), 'Malformed answer to “Plan for the next phase”');
  assert.equal(errorLabel('probabilities_invalid:coupling'), 'Invalid probabilities for “How coupled are the workstreams?”');
  assert.equal(errorLabel('malformed_answer:novel_question'), 'Malformed answer to “novel question”');
  assert.equal(errorLabel('missing_usage'), 'The answer did not report token usage');
  assert.equal(errorLabel('model_missing'), 'The answer did not name the resolved model');
  assert.equal(errorLabel('response_too_large'), 'The response exceeded the size limit');
  assert.equal(errorLabel('http_503'), 'TypeSafe returned HTTP 503');
  assert.equal(errorLabel('network'), 'TypeSafe could not be reached (network error)');
  assert.equal(errorLabel(null), 'Jev unavailable');
  assert.equal(errorLabel('something_new'), 'something_new');
});

test('joint plan answers (contract v3) and topology/budget answers (v2) both render', () => {
  const plans = { single: 0.01, brain_one_worker: 0.01, brain_multi_dm_2: 0.01, brain_multi_room_2: 0.01, brain_multi_dm_3: 0.95, brain_multi_room_3: 0.01 };
  const rows = questionRows({ questions: { plan: { type: 'choice' } } },
    { answers: { plan: { type: 'choice', choice: 'brain_multi_dm_3', confidence: 0.9, probabilities: plans } } });
  assert.equal(rows[0]!.question, 'Plan for the next phase');
  assert.equal(rows[0]!.answer, 'Multi-DM · 3 workers');
  assert.deepEqual(rows[0]!.options.map(option => option.label),
    ['Single', 'Brain + 1', 'Multi-DM · 2 workers', 'Room · 2 workers', 'Multi-DM · 3 workers', 'Room · 3 workers']);
  const blocked = questionRows({ questions: { plan: { type: 'choice' } } }, { answers: { plan: { type: 'choice', choice: 'capacity_blocked' } } });
  assert.equal(blocked[0]!.answer, 'Needs workers, none available');
  const legacy = questionRows({ questions: { target_topology: { type: 'choice' }, worker_budget: { type: 'choice' } } },
    { answers: { target_topology: { choice: 'brain_one_worker' }, worker_budget: { choice: 'workers_2' } } });
  assert.deepEqual(legacy.map(row => [row.question, row.answer]),
    [['Best way to organize the work', 'Brain + 1'], ['How many workers are needed?', '2 workers']]);
});

test('a rejected call shows its specific reason with the resolved model and tokens', async t => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const rejected = summary('rejected', { status: 'unavailable', confidence: null, reason: 'response_rejected_preserve_current',
    error: 'plan_not_offered', model: 'jev-1.13.0', inputTokens: 2851, outputTokens: 248, requestedModel: 'jev-latest',
    targetTopology: 'single', targetWorkers: 0, outcome: null });
  t.mock.method(api, 'jevCalls', async () => ({ hasMore: false, nextCursor: null, requests: [{ executionId: 'exec-1', channelId: 'dm', brainId: 'brain-1',
    request: 'Refactor the parser.', firstAt: 1_000, lastAt: 1_000, callCount: 1, calls: [rejected] }] }));
  const plan = { type: 'choice', choice: 'brain_one_worker_2', confidence: 0.9, probabilities: { single: 0.05, brain_one_worker: 0.95 } };
  t.mock.method(api, 'jevCall', async () => ({ call: { ...rejected, sent: { ...sent, questions: { plan: { type: 'choice' } } },
    received: { model: 'jev-1.13.0', answers: { plan }, usage: { input_tokens: 2851, output_tokens: 248 } } } }));
  await act(async () => root.render(<JevLog project="chapter" tick={0} channelLabel={() => 'dm'} agentName={() => 'Atlas'} onOpenChannel={() => {}} />));
  const text = () => host.textContent ?? '';
  assert.match(text(), /Answer rejected · Jev chose a plan that was not offered/);
  assert.doesNotMatch(text(), /Invalid Jev response/);
  await act(async () => (host.querySelector('button.jev-call') as HTMLElement).click());
  assert.match(text(), /Jev answered, but Hivemind rejected the answer: Jev chose a plan that was not offered\. The brain was told Jev had no advice\./);
  assert.match(text(), /Why it was rejectedJev chose a plan that was not offered \(plan_not_offered\)/);
  assert.match(text(), /ReasonJev answer rejected/);
  assert.doesNotMatch(text(), /mode kept/);
  assert.match(text(), /jev-1\.13\.0/);
  assert.match(text(), /2851 in \/ 248 out/);
  assert.match(text(), /Plan for the next phase/);
});

test('uncertain and incoherent answers are labelled as such, and the default alias resolving is information only (#209)', async t => {
  assert.equal(answerLabel(summary('low', { confidence: 0.17 })), 'Brain + 1 · 1 worker · 17% · uncertain');
  const incoherent = summary('incoherent', { targetTopology: 'single', targetWorkers: 0, confidence: 0.39, incoherent: 'plan_vs_sufficiency',
    reason: 'incoherent_plan_vs_sufficiency', model: 'jev-1.13.0', requestedModel: 'jev-latest' });
  assert.equal(answerLabel(incoherent), 'Single · 39% · uncertain · incoherent: plan contradicts sufficiency');
  assert.deepEqual(modelLabel({ ...incoherent, sent: null, received: null }), { text: 'jev-latest → jev-1.13.0', mismatch: false });
  assert.deepEqual(modelLabel({ ...incoherent, requestedModel: 'jev-2026-09-01', sent: null, received: null }),
    { text: 'jev-2026-09-01 → jev-1.13.0', mismatch: true });

  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  let detail: JevCall = { ...incoherent, sent, received };
  t.mock.method(api, 'jevCalls', async () => ({ hasMore: false, nextCursor: null, requests: [{ executionId: 'exec-1', channelId: 'dm', brainId: 'brain-1',
    request: 'Una volta terminati questi passaggi quale è il piano?', firstAt: 1_000, lastAt: 1_000, callCount: 1, calls: [incoherent] }] }));
  t.mock.method(api, 'jevCall', async () => ({ call: detail }));
  const render = async () => {
    await act(async () => root.render(<JevLog project="chapter" tick={0} channelLabel={() => 'dm'} agentName={() => 'Atlas'} onOpenChannel={() => {}} />));
    await act(async () => (host.querySelector('button.jev-call') as HTMLElement).click());
  };
  await render();
  const text = () => host.textContent ?? '';
  assert.doesNotMatch(text(), /Jev unavailable|Answer rejected|differs/);
  assert.match(text(), /Jev uncertain \(incoherent: plan contradicts sufficiency\)/);
  assert.match(text(), /Uncertain advice returned to the brain/);
  assert.match(text(), /Jev's answers contradict each other \(plan contradicts sufficiency\)\. The brain received it as uncertain advice\./);
  assert.match(text(), /uncertain · incoherent: plan contradicts sufficiency: below 60% or not coherent/);
  assert.match(text(), /jev-latest → jev-1\.13\.0/);
  assert.match(text(), /ReasonJev chose Single while saying delegation helps \(incoherent\)/);
  // A pinned identifier that resolves to something else is still flagged.
  await act(async () => root.unmount());
  const pinnedRoot = createRoot(host);
  t.after(async () => { await act(async () => pinnedRoot.unmount()); });
  detail = { ...detail, requestedModel: 'jev-2026-09-01' };
  await act(async () => pinnedRoot.render(<JevLog project="chapter" tick={1} channelLabel={() => 'dm'} agentName={() => 'Atlas'} onOpenChannel={() => {}} />));
  await act(async () => (host.querySelector('button.jev-call') as HTMLElement).click());
  assert.match(text(), /jev-2026-09-01 → jev-1\.13\.0 \(differs from the pinned model\)/);
});

test('routing events say what Jev suggested, or whether it was unavailable, rejected, uncertain or incoherent (#211)', () => {
  const base: AdaptiveRoutingEvent = { id: 'e', executionId: 'x', channelId: 'dm', projectId: 'p', createdAt: 1, kind: 'advice',
    trigger: 'task_event', targetTopology: 'single', targetWorkers: 0, confidence: 0.39, reason: 'single_sufficient', providerStatus: 'ok' };
  assert.equal(routingEventLabel(base), 'Brain task update · Jev uncertain (39%) · Single');
  assert.equal(routingEventLabel({ ...base, confidence: 0.99, incoherent: 'plan_vs_sufficiency', reason: 'incoherent_plan_vs_sufficiency' }),
    'Brain task update · Jev uncertain (incoherent: plan contradicts sufficiency)');
  assert.equal(routingEventLabel({ ...base, confidence: 0.95 }), 'Brain task update · Jev suggested Single (95%)');
  assert.equal(routingEventLabel({ ...base, trigger: 'human_request', providerStatus: 'unavailable', confidence: null, error: 'timeout',
    reason: 'provider_timeout_preserve_current' }), 'Your new request · Jev unavailable (timeout)');
  assert.equal(routingEventLabel({ ...base, providerStatus: 'unavailable', confidence: null, error: 'plan_not_offered',
    reason: 'response_rejected_preserve_current' }), 'Brain task update · Jev answer rejected (plan_not_offered)');
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
  const calls = [summary('first', { outcome: { kind: 'evaluation', applied: false, appliedTopology: 'brain_one_worker', appliedWorkers: 1, warning: null } }),
    summary('second', { phase: 'continuous', trigger: { kind: 'brain_message', eventType: 'progress' }, createdAt: 2_000 })];
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
  assert.match(text(), /Jev suggested Brain \+ 1 \(93%\)/, 'the request badge shows the latest advice');
  assert.match(text(), /Advice returned to the brain · not enforced/);
  assert.match(text(), /Before #211: kept Brain \+ 1/, 'a legacy call keeps its enforced outcome');
  assert.doesNotMatch(text(), /Applied →|Mode confirmed/);
  const call = Array.from(host.querySelectorAll('button.jev-call'))[0] as HTMLElement;
  await act(async () => call.click());
  assert.match(text(), /1 · Sent to Jev/);
  assert.match(text(), /2 free · 0 working for this brain · 1 busy elsewhere/);
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
