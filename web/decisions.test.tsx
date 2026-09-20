import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { DecisionCard, DecisionQueue } from './DecisionQueue.tsx';
import { api } from './api.ts';
import type { DecisionPage, DecisionView } from '../src/shared/decisions.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

function decision(state: DecisionView['state'] = 'awaiting_input'): DecisionView {
  return {
    id: '11111111-1111-4111-8111-111111111111', projectId: 'project', channelId: 'room',
    taskId: '22222222-2222-4222-8222-222222222222', taskRevision: 3, requesterId: 'brain',
    requesterName: 'Brain', revision: 1, storedState: state === 'expired' ? 'awaiting_input' : state === 'superseded' ? 'awaiting_input' : state as DecisionView['storedState'],
    question: 'Which compatibility boundary?', options: [
      { id: 'strict', label: 'Strict', impact: 'Reject old payloads' },
      { id: 'compat', label: 'Compatible', impact: 'Keep old payloads' },
    ], recommendation: { optionId: 'compat', rationale: 'Lower migration risk', uncertainty: 'Medium; production distribution is unknown' },
    evidenceSeqs: [42], artifacts: ['src/parser.ts'], affectedWorkers: [{ id: 'worker', name: 'Worker' }],
    requestedByAt: null, relatedDecisionIds: [], supersedesDecisionId: null, supersededByDecisionId: null,
    rootSeq: 41, createdAt: 1, updatedAt: 1, answer: null, withdrawn: null, state,
    currentTaskRevision: state === 'superseded' ? 4 : 3,
    staleReason: state === 'superseded' ? 'task_changed' : state === 'expired' ? 'deadline_passed' : null,
    delivery: [], warning: state === 'awaiting_input' ? 'Awaiting' : 'Stale decision warning',
  };
}

test('mounted decision queue exposes impact, uncertainty and sends an explicit Human answer', async t => {
  const initial = decision(), page: DecisionPage = { items: [initial], awaiting: 1, warning: 'Explicit requests only' };
  t.mock.method(api, 'decisions', async () => page);
  const answers: Parameters<typeof api.answerDecision>[1][] = [];
  t.mock.method(api, 'answerDecision', async (_id: string, body: Parameters<typeof api.answerDecision>[1]) => {
    answers.push(body);
    return { decision: { ...initial, state: 'answered', storedState: 'answered', revision: 2,
      answer: { messageId: 'message', seq: 44, body: body.body, at: 2, source: 'hive' },
      delivery: [{ agentId: 'worker', name: 'Worker', state: 'pending' }] }, message: {} as never, duplicate: false };
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<DecisionQueue project="chapter" tick={0} onOpen={() => undefined} />));
    assert.match(host.textContent!, /Reject old payloads/); assert.match(host.textContent!, /Lower migration risk/);
    assert.match(host.textContent!, /production distribution is unknown/);
    const option = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Compatible'))!;
    await act(async () => option.click());
    const submit = [...host.querySelectorAll('button')].find(button => button.textContent === 'Answer')!;
    await act(async () => submit.click());
    assert.equal(answers.length, 1); assert.equal(answers[0]!.body, 'compat: Compatible');
    assert.match(host.textContent!, /Human answer/); assert.match(host.textContent!, /Worker: pending/);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test('stale decision card cannot answer and makes the changed task revision visible', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<DecisionCard decision={decision('superseded')} onAnswered={() => undefined} />));
    assert.match(host.textContent!, /superseded/); assert.match(host.textContent!, /Stale decision warning/);
    assert.equal(host.querySelector('textarea'), null);
    assert.ok([...host.querySelectorAll('button')].filter(button => button.textContent?.includes('Compatible')).every(button => button.disabled));
  } finally { await act(async () => root.unmount()); host.remove(); }
});
