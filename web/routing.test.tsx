import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { WorkerRouting } from './WorkerRouting.tsx';
import { api } from './api.ts';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import type { RoutingSuggestions } from '../src/shared/routing.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());
const task: TaskSnapshot = { id: 'task', channelId: 'room', assignerId: 'brain', assignerName: 'Brain', workerId: 'worker', workerName: 'Worker',
  revision: 1, contractVersion: 1, state: 'sent', dispatchSeq: 1, receivedAt: null, lastEventSeq: 1, updatedAt: 0,
  contract: { objective: 'Test', scope: [], nonGoals: [], acceptanceCriteria: ['Review'], dependencies: [], evidenceSeqs: [] }, result: null, review: null };
function response(name = 'Worker'): RoutingSuggestions {
  return { taskId: task.id, taskRevision: 1, category: 'general', eligibleTotal: 1, consideredCards: 1, nextOffset: null,
    warning: 'Declarations are not verified runtime quality.', delegationAdvice: 'Consider not delegating small work.', candidates: [{ workerId: 'worker', name, capabilityRevision: 1,
      card: { enabled: true, capabilities: ['parser'], modes: ['implementation'], model: null, host: null, availableContext: null, availability: 'available', maxInProgress: 1 },
      visibleInProgress: 0, workloadIncomplete: true, providerCost: null, reasons: ['Cold start is not excluded.'],
      evidence: { accepted: 0, reviewed: 0, acceptedRate: null, interval95: null, basis: 'No evidence' } }] };
}

test('mounted routing is opt-in, reports uncertainty, and drops delayed results after task navigation', async t => {
  let resolve!: (value: RoutingSuggestions) => void, calls = 0;
  t.mock.method(api, 'suggestWorkers', () => { calls++; return new Promise<RoutingSuggestions>(yes => { resolve = yes; }); });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = async (current = task) => { await act(async () => root.render(<WorkerRouting task={current} />)); };
  try {
    await render(); assert.equal(calls, 0);
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click()); assert.equal(calls, 1);
    await render({ ...task, id: 'other-task' });
    await act(async () => resolve(response('Obsolete worker')));
    assert.ok(!host.textContent!.includes('Obsolete worker'));
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
    await act(async () => resolve(response('<script>untrusted</script>')));
    assert.match(host.textContent!, /Provider cost: unknown/); assert.match(host.textContent!, /Cold start/);
    assert.equal(host.querySelector('script'), null);
    assert.match(host.textContent!, /No matching reviewed outcomes/);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test('mounted override preserves a lost-response key and never claims a task was reassigned', async t => {
  t.mock.method(api, 'suggestWorkers', async () => response());
  const keys: string[] = [];
  t.mock.method(api, 'recordRoutingChoice', async (_id: string, payload: Parameters<typeof api.recordRoutingChoice>[1]) => {
    keys.push(payload.requestId); if (keys.length === 1) throw new Error('Response lost'); return { assigned: false };
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const click = async (label: string) => { const button = [...host.querySelectorAll('button')].find(b => b.textContent === label); assert.ok(button, label); await act(async () => button.click()); };
  try {
    await act(async () => root.render(<WorkerRouting task={task} />)); await click('Find eligible workers');
    await click('Record preference for Worker');
    await act(async () => {
      const input = host.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Intentional preference');
      input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    });
    await click('Record choice without assigning'); assert.match(host.textContent!, /Response lost/);
    await click('Record choice without assigning'); assert.deepEqual(keys, [keys[0], keys[0]]);
    assert.match(host.textContent!, /Task ownership and running agents are unchanged/);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
