import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import type { JobView } from '../src/shared/jobs.ts';
import type { TaskControlInput } from '../src/shared/task-control.ts';
import type { TaskOverview, TaskViewsPage } from '../src/shared/task-views.ts';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import type { Agent, Project } from '../src/shared/types.ts';
import { api, ApiError } from './api.ts';
import { Composer } from './Composer.tsx';
import { groupTaskViews, mergeTaskPages, taskControls, workerTrafficLabel } from './task-views-model.ts';
import { TaskViews } from './TaskViews.tsx';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

const project: Project = { id: 'p-alpha', slug: 'alpha', name: 'Alpha', worktree: null, createdAt: 1 };
const brain: Agent = { id: 'b', name: 'Atlas', role: 'brain', projectId: project.id, project: project.slug,
  seniority: null, focus: null, online: true, lastSeenAt: 1, createdAt: 1 };
const worker: Agent = { id: 'w', name: 'Forge', role: 'worker', projectId: project.id, project: project.slug,
  templateId: 'template-1', seniority: 'mid', focus: null, online: true, lastSeenAt: 1, createdAt: 1 };
const baseTask: TaskSnapshot = { id: 'task-1', channelId: 'channel-1', assignerId: brain.id, assignerName: brain.name,
  workerId: worker.id, workerName: worker.name, revision: 2, contractVersion: 1, state: 'accepted',
  contract: { objective: 'Draft the API', scope: [], nonGoals: [], acceptanceCriteria: ['Reviewed'],
    dependencies: [], evidenceSeqs: [] }, dispatchSeq: 1, receivedAt: 1, lastEventSeq: 2,
  updatedAt: Date.now(), result: null, review: null };
const overview = (task: TaskSnapshot = baseTask, extra: Partial<TaskOverview> = {}): TaskOverview => ({
  task, projectId: project.id, project: project.slug, brain, worker, template: { id: 'template-1', label: 'Implementation' },
  traffic: null,
  controls: { retryClose: false, resume: false }, ...extra,
});
const job: JobView = { id: 'job-1', projectId: project.id, brainId: brain.id, originMessageId: null,
  title: 'Release API', state: 'active', revision: 1, createdAt: 1, updatedAt: 2, closedAt: null,
  counts: { total: 1, completed: 0, cancelled: 0, paused: 0, active: 1 } };
const page = (items: TaskOverview[] = [overview()]): TaskViewsPage => ({ items, jobs: [], hasMore: false, nextCursor: null });

async function mount(t: TestContext, initial: { project?: string | null; tick?: number } = {}) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const calls = { project: [] as string[], thread: [] as string[], brain: [] as string[] };
  const render = async (props: { project?: string | null; tick?: number } = initial) => act(async () => {
    root.render(<TaskViews project={props.project === undefined ? 'alpha' : props.project} tick={props.tick ?? 0}
      projects={[project]} agents={[brain, worker]}
      traffic={{ [worker.id]: { since: 100, bytes: 2048, calls: 3, routes: {} } }}
      onProject={slug => calls.project.push(slug)} onBack={() => {}}
      onAll={() => calls.project.push('all')} onOpenThread={item => calls.thread.push(item.task.id)}
      onMessageBrain={item => calls.brain.push(item.task.id)} />);
  });
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render();
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.trim() === label)!;
  return { host, button, render, calls };
}

test('groups page-linked and empty jobs while retaining ungrouped tasks', () => {
  const grouped = groupTaskViews({ jobs: [job, { ...job, id: 'empty', title: 'Next release' }],
    items: [overview({ ...baseTask, jobId: job.id }), overview({ ...baseTask, id: 'loose' })] });
  assert.deepEqual(grouped.map(group => [group.job?.title ?? null, group.items.map(item => item.task.id)]),
    [['Release API', ['task-1']], ['Next release', []], [null, ['loose']]]);
});

test('later pages refresh duplicate task and job projections without duplicating rows', () => {
  const first = { ...page([overview({ ...baseTask, jobId: job.id })]), jobs: [job], hasMore: true, nextCursor: 'next' };
  const next = { ...page([overview({ ...baseTask, jobId: job.id, revision: 3 }), overview({ ...baseTask, id: 'other' })]),
    jobs: [{ ...job, counts: { ...job.counts, total: 2 } }] };
  const merged = mergeTaskPages(first, next);
  assert.deepEqual(merged.items.map(item => [item.task.id, item.task.revision]), [['task-1', 3], ['other', 2]]);
  assert.equal(merged.jobs[0]?.counts.total, 2);
  assert.equal(merged.hasMore, false);
});

test('control affordances follow task state and server-confirmed native close gates', () => {
  assert.deepEqual(taskControls(overview()).pauseSoft, true);
  assert.equal(taskControls(overview(baseTask, { worker: { ...worker, templateId: undefined } })).pauseHard, false);
  const hard = { ...baseTask, state: 'paused' as const, pause: { mode: 'hard' as const,
    requestId: 'old', previousState: 'accepted' as const, requestedAt: 1, graceUntil: 2, stopRequestedAt: 3 } };
  assert.equal(taskControls(overview(hard)).retryClose, false, 'an in-flight kill is not retryable');
  assert.equal(taskControls(overview(hard, { controls: { retryClose: true, resume: false } })).retryClose, true);
  assert.equal(taskControls(overview({ ...hard, pause: { ...hard.pause, closedAt: 4 } },
    { controls: { retryClose: false, resume: true } })).resume, true);
  assert.equal(taskControls(overview({ ...baseTask, state: 'accepted_complete' })).cancel, false);
  assert.match(workerTrafficLabel({ since: 100, bytes: 2048, calls: 3, routes: {} }), /2\.0 KB returned across 3 calls since server start/);
});

test('cards show job, checkpoint, historical labels, traffic scope, and thread/brain navigation', async t => {
  const checkpoint = { version: 1, taskRevision: 2, contractVersion: 1, workerId: worker.id,
    objective: 'Draft the API', savedAt: Date.now() - 300_000, state: 'accepted' as const,
    messageId: 'checkpoint', messageSeq: 3,
    data: { completedSteps: ['Outlined routes'], unresolvedQuestions: ['Auth policy'], nextAction: 'Review DTO',
      artifacts: [], checks: [], evidenceSeqs: [] } };
  t.mock.method(api, 'tasks', async () => ({ ...page([overview({ ...baseTask, jobId: job.id, checkpoint,
    workerName: 'Forge (archived)', assignerName: 'Atlas (archived)' }, { brain: { ...brain, archivedAt: 10 },
    worker: { ...worker, archivedAt: 10 }, traffic: { since: 100, bytes: 4096, calls: 7, routes: {} } })]), jobs: [job] }));
  const view = await mount(t);
  assert.match(view.host.textContent!, /Release API/);
  assert.match(view.host.textContent!, /Outlined routes/);
  assert.match(view.host.textContent!, /Auth policy/);
  assert.match(view.host.textContent!, /Review DTO/);
  assert.match(view.host.textContent!, /Forge \(archived\)/);
  assert.match(view.host.textContent!, /since server start/);
  assert.match(view.host.textContent!, /4\.0 KB returned across 7 calls/);
  assert.match(view.host.textContent!, /not task-specific/);
  assert.equal(view.button('Message brain').disabled, true);
  await act(async () => view.button('Open thread').click());
  assert.deepEqual(view.calls.thread, ['task-1']);
});

test('task controls send a UUID, exact revision and action, including cancel reason and native-close retry', async t => {
  let current = overview();
  const sent: TaskControlInput[] = [];
  t.mock.method(api, 'tasks', async () => page([current]));
  t.mock.method(api, 'controlTask', async (_id: string, body: TaskControlInput) => {
    sent.push(body);
    return { task: current.task };
  });
  const view = await mount(t);
  for (const [label, action] of [['Pause soft', { type: 'pause', mode: 'soft' }],
    ['Pause hard', { type: 'pause', mode: 'hard' }]] as const) {
    await act(async () => view.button(label).click());
    assert.deepEqual(sent.at(-1)!.action, action);
    assert.equal(sent.at(-1)!.expectedRevision, 2);
    assert.match(sent.at(-1)!.requestId, /^[0-9a-f-]{36}$/);
  }
  await act(async () => view.button('Cancel task').click());
  const reason = view.host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(reason, 'No longer needed');
    reason.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
  });
  await act(async () => view.button('Confirm cancellation').click());
  assert.deepEqual(sent.at(-1)!.action, { type: 'cancel', reason: 'No longer needed' });

  current = overview({ ...baseTask, state: 'paused', pause: { mode: 'soft', requestId: 'p', previousState: 'accepted',
    requestedAt: 1, graceUntil: null } }, { controls: { retryClose: false, resume: true } });
  await act(async () => view.button('Refresh').click());
  await act(async () => view.button('Resume').click());
  assert.deepEqual(sent.at(-1)!.action, { type: 'resume' });

  current = overview({ ...baseTask, state: 'paused', pause: { mode: 'hard', requestId: 'p', previousState: 'accepted',
    requestedAt: 1, graceUntil: 2, stopRequestedAt: 3 } }, { controls: { retryClose: true, resume: false } });
  await act(async () => view.button('Refresh').click());
  assert.match(view.host.textContent!, /worker session close failed; retry needed/);
  await act(async () => view.button('Retry close').click());
  assert.deepEqual(sent.at(-1)!.action, { type: 'pause', mode: 'hard' });
});

test('unknown outcome requires a status check then retries the identical request', async t => {
  const sent: TaskControlInput[] = [];
  t.mock.method(api, 'tasks', async () => page());
  t.mock.method(api, 'task', async () => ({ item: overview() }));
  t.mock.method(api, 'controlTask', async (_id: string, body: TaskControlInput) => {
    sent.push(body); throw new Error('connection lost');
  });
  const view = await mount(t);
  await act(async () => view.button('Pause soft').click());
  assert.match(view.host.textContent!, /Outcome unknown/);
  assert.equal(view.button('Retry same request').disabled, true);
  await act(async () => view.button('Check status').click());
  assert.equal(view.button('Retry same request').disabled, false);
  await act(async () => view.button('Retry same request').click());
  assert.deepEqual(sent, [sent[0], sent[0]]);
});

test('an HTTP rejection refreshes the current task and explains the error', async t => {
  t.mock.method(api, 'tasks', async () => page());
  t.mock.method(api, 'task', async () => ({ item: overview() }));
  t.mock.method(api, 'controlTask', async () => { throw new ApiError(409, 'Task changed'); });
  const view = await mount(t);
  await act(async () => view.button('Pause soft').click());
  assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? '', /Task changed/);
  assert.equal(view.button('Retry same request'), undefined);
});

test('a control completed after a scope change cannot reload or overwrite the new scope', async t => {
  let finish!: (value: { task: TaskSnapshot }) => void;
  const control = new Promise<{ task: TaskSnapshot }>(resolve => { finish = resolve; });
  const scopes: Array<string | null> = [];
  t.mock.method(api, 'tasks', async (scope: string | null) => {
    scopes.push(scope);
    return page([overview({ ...baseTask, id: scope === 'alpha' ? 'alpha-task' : 'beta-task',
      contract: { ...baseTask.contract, objective: scope === 'alpha' ? 'Alpha objective' : 'Beta objective' } })]);
  });
  t.mock.method(api, 'controlTask', async () => control);
  const view = await mount(t);
  await act(async () => view.button('Pause soft').click());
  await view.render({ project: 'beta' });
  assert.match(view.host.textContent!, /Beta objective/);
  await act(async () => finish({ task: { ...baseTask, id: 'alpha-task', revision: 3 } }));
  assert.match(view.host.textContent!, /Beta objective/);
  assert.doesNotMatch(view.host.textContent!, /Alpha objective/);
  assert.deepEqual(scopes, ['alpha', 'beta']);
});

test('a delayed list response cannot show old project cards while the scope changes', async t => {
  let finishAlpha!: (value: TaskViewsPage) => void;
  const alpha = new Promise<TaskViewsPage>(resolve => { finishAlpha = resolve; });
  t.mock.method(api, 'tasks', async (scope: string | null) => scope === 'alpha' ? alpha : page([
    overview({ ...baseTask, id: 'beta-task', contract: { ...baseTask.contract, objective: 'Beta objective' } })]));
  const view = await mount(t);
  await view.render({ project: 'beta' });
  assert.match(view.host.textContent!, /Beta objective/);
  finishAlpha(page([overview({ ...baseTask, contract: { ...baseTask.contract, objective: 'Alpha objective' } })]));
  await act(async () => { await alpha; });
  assert.match(view.host.textContent!, /Beta objective/);
  assert.doesNotMatch(view.host.textContent!, /Alpha objective/);
});

test('HTTP methods and bodies match task list, detail and control routes', async t => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/ui/session') return Response.json({ ok: true });
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(url.endsWith('/control') ? { task: baseTask } : url.includes('/tasks/task-1') ? { item: overview() } : page());
  });
  await api.tasks('all', 'opaque/cursor');
  await api.tasks(null);
  await api.task('task-1');
  await api.controlTask('task-1', { requestId: '8b9e794d-9dfa-42af-ae67-6d84f7c29119', expectedRevision: 2,
    action: { type: 'pause', mode: 'hard' } });
  assert.deepEqual(calls, [
    { url: '/api/ui/tasks?project=all&cursor=opaque%2Fcursor', method: 'GET', body: null },
    { url: '/api/ui/tasks', method: 'GET', body: null },
    { url: '/api/ui/tasks/task-1', method: 'GET', body: null },
    { url: '/api/ui/tasks/task-1/control', method: 'POST', body: {
      requestId: '8b9e794d-9dfa-42af-ae67-6d84f7c29119', expectedRevision: 2, action: { type: 'pause', mode: 'hard' } } },
  ]);
});

test('Message brain task reference is inserted once and never reappears after send and remount', async t => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const sent: string[] = [];
  function Harness() {
    const [shown, setShown] = useState(true);
    const [draft, setDraft] = useState<{ token: string; text: string } | null>({ token: 'task-link-1',
      text: '[Task task-1](#/c/channel-1/t/task-1)' });
    return <><button type="button" onClick={() => setShown(value => !value)}>Toggle composer</button>
      {shown && <Composer agents={[brain]} placeholder="Message Atlas" draftInsert={draft}
        onDraftInserted={token => setDraft(current => current?.token === token ? null : current)}
        onSend={async body => { sent.push(body); return true; }} />}</>;
  }
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<Harness />));
  const input = () => host.querySelector<HTMLTextAreaElement>('textarea')!;
  assert.equal(input().value, '[Task task-1](#/c/channel-1/t/task-1)');
  await act(async () => host.querySelector<HTMLButtonElement>('.composer .send')!.click());
  assert.deepEqual(sent, ['[Task task-1](#/c/channel-1/t/task-1)']);
  assert.equal(input().value, '');
  const toggle = host.querySelector<HTMLButtonElement>('button')!;
  await act(async () => toggle.click());
  await act(async () => toggle.click());
  assert.equal(input().value, '');
});
