import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { DecisionCard, DecisionQueue } from './DecisionQueue.tsx';
import { api } from './api.ts';
import type { DecisionPage, DecisionView } from '../src/shared/decisions.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLInputElement: window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true });
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
    await act(async () => root.render(<DecisionQueue project="acme" tick={0} onOpen={() => undefined} />));
    assert.match(host.textContent!, /Reject old payloads/); assert.match(host.textContent!, /Lower migration risk/);
    assert.match(host.textContent!, /production distribution is unknown/);
    // The recommended option is tagged on its card and named by label, not id.
    const option = (label: string) => [...host.querySelectorAll('.decision-options button')].find(button => button.textContent?.includes(label))!;
    assert.match(option('Compatible').textContent!, /Recommended/); assert.doesNotMatch(option('Strict').textContent!, /Recommended/);
    assert.match(host.textContent!, /Recommended: Compatible\. Lower migration risk/); assert.doesNotMatch(host.textContent!, /Option compat/);
    // One click selects and asks for confirmation; nothing is sent until Confirm, and Cancel backs out.
    await act(async () => (option('Strict') as HTMLButtonElement).click());
    assert.equal(option('Strict').getAttribute('aria-pressed'), 'true');
    const confirmBox = () => host.querySelector('.decision-confirm');
    assert.match(confirmBox()!.textContent!, /Answer Strict/);
    const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text)!;
    await act(async () => button('Cancel').click());
    assert.equal(confirmBox(), null); assert.equal(answers.length, 0);
    await act(async () => (option('Compatible') as HTMLButtonElement).click());
    assert.match(confirmBox()!.textContent!, /Answer Compatible \(recommended\)/);
    assert.ok(host.querySelector('textarea[aria-label="Decision answer"]'), 'a free-text answer stays available');
    const note = host.querySelector<HTMLInputElement>('input[aria-label="Optional note"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(note, 'Ship behind a flag');
      note.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    });
    await act(async () => button('Confirm').click());
    assert.equal(answers.length, 1); assert.equal(answers[0]!.body, 'compat: Compatible\n\nShip behind a flag');
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
