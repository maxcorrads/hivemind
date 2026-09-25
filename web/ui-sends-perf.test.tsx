import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { act, useRef, useState, type ReactElement } from 'react';
import { HEALTHY_EVIDENCE_COLLECTOR } from '../src/shared/evidence-health.ts';
import type { JevCallLogView, JevCallSummary } from '../src/shared/jev-calls.ts';
import type { Agent, Channel, Message } from '../src/shared/types.ts';
import { api, type ChannelPayload } from './api.ts';
import { ChannelDesk } from './ChannelDesk.tsx';
import { Composer } from './Composer.tsx';
import { JevLog } from './JevLog.tsx';
import { renderBody } from './markdown.tsx';
import type { Sel } from './selection.ts';
import type { ChannelPane } from './use-channel-pane.ts';
import type { JevLiveEvent, JevLiveSubscribe } from './use-realtime.ts';
import { useSearch } from './use-search.ts';
import { useSend } from './use-send.ts';
import type { ThreadPane } from './use-thread-pane.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, location: window.location,
  HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const channel: Channel = { id: 'a', name: 'Alpha', type: 'dm', topic: null, memberIds: ['human'], projectId: 'p', project: 'alpha',
  createdBy: 'human', createdAt: 1 };
const agent = (name: string, role: Agent['role'] = 'worker'): Agent => ({ id: name.toLowerCase(), name, role, seniority: null,
  focus: null, online: true, lastSeenAt: 1, createdAt: 1, projectId: 'p', project: 'alpha' });
function message(seq: number, extra: Partial<Message> = {}): Message {
  return { id: `m-${seq}`, seq, channelId: channel.id, threadId: null, body: `Message **${seq}**`, authorId: 'human', authorName: 'Human',
    authorRole: 'human', kind: 'chat', control: null, mentions: [], createdAt: seq, reactions: [],
    attachments: [{ id: `f-${seq}`, name: `f-${seq}.png`, mime: 'image/png', bytes: 2048 }], ...extra };
}

function mount(t: TestContext) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const textarea = () => host.querySelector<HTMLTextAreaElement>('.composer textarea')!;
  const send = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Send')!;
  return {
    host, textarea, send,
    render: (element: ReactElement) => act(async () => root.render(element)),
    async type(value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value);
        textarea().dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
      });
    },
    async key(key: string, init: { isComposing?: boolean; keyCode?: number; shiftKey?: boolean } = {}) {
      const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      await act(async () => { textarea().dispatchEvent(event as unknown as Event); });
      return event.defaultPrevented;
    },
    async attach(name: string) {
      const input = host.querySelector<HTMLInputElement>('.composer input[type="file"]')!;
      const file = new File(['x'], name, { type: 'text/plain' });
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event); });
      return file;
    },
    pendingFiles: () => [...host.querySelectorAll('.pending-files li')].map(item => item.textContent!.replace('×', '')),
    hints: () => [...host.querySelectorAll('.hints button')].map(button => ({ text: button.textContent, active: button.classList.contains('active') })),
  };
}

/** useSend wired to a Composer, as ChannelDesk does, with an in-memory channel pane. */
function SendHarness({ errors }: { errors: string[] }) {
  const [pane, setPane] = useState<ChannelPayload | null>({ channel, threadId: null, messages: [], threads: [], replyCounts: {} });
  const sel: Sel = { kind: 'channel', id: channel.id };
  const selRef = useRef<Sel>(sel), threadIdRef = useRef<string | null>(null);
  const channelPane = { pane, setPane, channelStream: useRef(null), channelJournal: useRef(null),
    loadChannel: async () => {} } as unknown as ChannelPane;
  const thread = { threadPane: null, threadStream: useRef(null), onThreadMessage: () => {}, loadThread: async () => {} } as unknown as ThreadPane;
  const { sendChannel } = useSend({ sel, selection: { selRef, threadIdRef }, channel: channelPane, thread,
    activeBrainChannel: false, refreshRoutingView: () => {}, setErr: error => errors.push(error) });
  return <>
    <ul className="sent">{pane?.messages.map(m => <li key={m.id}>{m.body}</li>)}</ul>
    <Composer agents={[]} onSend={sendChannel} placeholder="Message" />
  </>;
}

test('a failed upload keeps the draft and files, shows the error, and the retry sends once', async t => {
  let uploads = 0;
  const sends: string[] = [];
  t.mock.method(api, 'upload', async (file: File) => {
    if (++uploads === 1) throw new Error('upload offline');
    return { id: `upload-${file.name}` };
  });
  t.mock.method(api, 'send', async (channelId: string, body: string, _root: string | null, ids: string[], requestId: string) => {
    sends.push(`${body}|${ids.join(',')}|${requestId}`);
    return { message: { ...message(1), channelId, body, attachments: [] } };
  });
  const errors: string[] = [];
  const f = mount(t);
  await f.render(<SendHarness errors={errors} />);
  await f.type('With a file');
  await f.attach('notes.txt');
  await act(async () => f.send().click());
  assert.deepEqual(errors, ['Message not sent: upload offline']);
  assert.equal(f.textarea().value, 'With a file', 'the draft survives the failure');
  assert.deepEqual(f.pendingFiles(), ['notes.txt'], 'the attachment survives the failure');
  assert.equal(sends.length, 0);
  await act(async () => f.send().click());
  assert.equal(sends.length, 1);
  assert.match(sends[0]!, /^With a file\|upload-notes\.txt\|/);
  assert.equal(f.textarea().value, '');
  assert.deepEqual(f.pendingFiles(), []);
  assert.match(f.host.querySelector('.sent')!.textContent!, /With a file/);
});

test('a failed send keeps the draft; Send is disabled while a send is in flight', async t => {
  const attempts: Array<ReturnType<typeof deferred<{ message: Message }>>> = [];
  t.mock.method(api, 'send', () => { const next = deferred<{ message: Message }>(); attempts.push(next); return next.promise; });
  const errors: string[] = [];
  const f = mount(t);
  await f.render(<SendHarness errors={errors} />);
  await f.type('Hello');
  await f.key('Enter');
  assert.equal(f.send().disabled, true, 'no second send while the first is in flight');
  await f.key('Enter');
  assert.equal(attempts.length, 1);
  await act(async () => { attempts[0]!.reject(new Error('HTTP 503')); });
  assert.deepEqual(errors, ['Message not sent: HTTP 503']);
  assert.equal(f.textarea().value, 'Hello');
  assert.equal(f.send().disabled, false);
  await f.key('Enter');
  // Text typed while the retry is in flight is not discarded by its success.
  await f.type('Hello again');
  await act(async () => { attempts[1]!.resolve({ message: { ...message(2), body: 'Hello', attachments: [] } }); });
  assert.equal(f.textarea().value, 'Hello again');
});

test('mention autocomplete: arrows move, Enter/Tab insert, Escape closes, Enter sends only when closed and not composing', async t => {
  const sent: string[] = [];
  const f = mount(t);
  const agents = [agent('Ada'), agent('Adrian', 'brain'), agent('Adfeed', 'bot'), agent('Bob')];
  await f.render(<Composer agents={agents} placeholder="Message" onSend={async body => { sent.push(body); return true; }} />);
  await f.type('Hi @');
  assert.deepEqual(f.hints().map(h => h.text), ['@Adaworker', '@Adrianbrain', '@Bobworker'], 'a bare @ offers every non-bot');
  await f.type('Hi @Ad');
  assert.deepEqual(f.hints(), [{ text: '@Adaworker', active: true }, { text: '@Adrianbrain', active: false }], 'bots are never offered');
  assert.equal(f.textarea().getAttribute('aria-activedescendant'), f.host.querySelector('[role="option"][aria-selected="true"]')!.id);
  assert.equal(await f.key('ArrowDown'), true);
  assert.deepEqual(f.hints().map(h => h.active), [false, true]);
  await f.key('ArrowDown');
  assert.deepEqual(f.hints().map(h => h.active), [true, false], 'the selection wraps');
  await f.key('ArrowUp');
  assert.deepEqual(f.hints().map(h => h.active), [false, true]);
  assert.equal(await f.key('Enter', { isComposing: true }), false, 'an IME confirmation is left to the IME');
  assert.equal(f.textarea().value, 'Hi @Ad');
  assert.equal(await f.key('Enter'), true);
  assert.equal(f.textarea().value, 'Hi @Adrian ');
  assert.deepEqual(f.hints(), []);
  assert.deepEqual(sent, [], 'Enter picked the mention instead of sending');

  await f.type('Hi @Adrian and @a');
  assert.equal(await f.key('Tab'), true, 'Tab inserts instead of moving focus');
  assert.equal(f.textarea().value, 'Hi @Adrian and @Ada ');

  await f.type('Hi @Adrian and @Ada, @B');
  assert.equal(f.hints().length, 1);
  await f.key('Escape');
  assert.deepEqual(f.hints(), []);
  await f.key('Enter', { keyCode: 229 });
  assert.deepEqual(sent, [], 'keyCode 229 (composition in progress) never sends');
  await f.key('Enter', { shiftKey: true });
  assert.deepEqual(sent, [], 'Shift+Enter is a newline');
  await f.key('Enter');
  assert.deepEqual(sent, ['Hi @Adrian and @Ada, @B']);
  assert.equal(f.textarea().value, '');
});

test('typing re-renders only the composer; a live update re-renders only the changed message', async t => {
  let rendered = 0;
  t.mock.method(api, 'fileUrl', (id: string) => { rendered++; return `/files/${id}`; });
  t.mock.method(api, 'channelTasks', async () => ({ items: [], hasMore: false }));
  t.mock.method(api, 'decisions', async () => ({ items: [], awaiting: 0, warning: '' }));
  const f = mount(t);
  const go = () => {};
  const compose = { sendChannel: async () => true, sendThread: async () => true };
  let update!: (fn: (pane: ChannelPayload | null) => ChannelPayload | null) => void;
  const messages = Array.from({ length: 50 }, (_, i) => message(i + 1));
  function Desk() {
    const [pane, setPane] = useState<ChannelPayload | null>({ channel, threadId: null, messages,
      threads: [{ id: 'm-3', channelId: channel.id, status: 'blocked' }], replyCounts: { 'm-3': 2 } });
    update = setPane;
    const channelPane = { pane, setPane, channelStream: useRef(null), channelJournal: useRef(null),
      loadChannel: async () => {} } as unknown as ChannelPane;
    return <ChannelDesk channelId={channel.id} activeChannel={channel} agents={[]} roomAgents={[]} channel={channelPane}
      threadPaneId={null} stickBottom={useRef(true)} threadOpenAnchor={useRef(null)} go={go} roomTick={0} decisionTick={0} onDecisionAnswered={go} routingView={null}
      activeBrainChannel={false} brainNames={{}} onOpenRouting={go} onInvite={go} onBack={go} compose={compose} setErr={go} onMarkUnread={async () => {}} />;
  }
  await f.render(<Desk />);
  assert.equal(f.host.querySelectorAll('article.msg').length, 50);
  assert.match(f.host.querySelector('article.msg:nth-of-type(3)')!.textContent!, /blocked/);
  const perRender = rendered / 50;
  assert.equal(perRender, 2, 'each image attachment resolves its URL twice per render');
  rendered = 0;
  for (const text of ['H', 'He', 'Hel', 'Hell', 'Hello']) await f.type(text);
  assert.equal(f.textarea().value, 'Hello');
  assert.equal(rendered, 0, 'no message re-rendered while typing');
  await act(async () => update(pane => pane && ({ ...pane,
    messages: pane.messages.map(m => m.id === 'm-7' ? { ...m, reactions: [{ emoji: '👍', count: 1, mine: true }] } : m) })));
  assert.equal(rendered, perRender, 'only the reacted message re-rendered');
});

test('the Routing log merges live calls and collector health without refetching', async t => {
  const summary = (id: string, executionId: string, createdAt: number, projectId = 'p'): JevCallSummary => ({ id, routeId: id,
    projectId, channelId: 'dm', executionId, brainId: 'brain', createdAt, phase: 'initial',
    trigger: { kind: 'human_request', eventType: null }, request: `Request ${executionId}`, status: 'ok', targetTopology: 'single',
    targetWorkers: 0, confidence: 0.9, reason: 'single_sufficient', error: null, model: 'jev', latencyMs: 1, inputTokens: 1,
    outputTokens: 1, outcome: null });
  const first = summary('c1', 'exec-1', 1_000);
  const page = deferred<JevCallLogView>();
  let loads = 0, healthReads = 0;
  t.mock.method(api, 'jevCalls', () => { loads++; return page.promise; });
  t.mock.method(api, 'evidenceHealth', async () => { healthReads++; return HEALTHY_EVIDENCE_COLLECTOR; });
  let emit!: (event: JevLiveEvent) => void;
  const subscribe: JevLiveSubscribe = listener => { emit = listener; return () => {}; };
  const f = mount(t);
  await f.render(<JevLog project="alpha" projectId="p" tick={0} subscribe={subscribe} channelLabel={() => 'dm'}
    agentName={() => 'Atlas'} onOpenChannel={() => {}} />);
  // A call recorded while the first page is still loading is replayed onto it.
  await act(async () => emit({ type: 'call', call: summary('c2', 'exec-2', 2_000) }));
  await act(async () => page.resolve({ requests: [{ executionId: 'exec-1', channelId: 'dm', brainId: 'brain', request: 'Request exec-1',
    firstAt: 1_000, lastAt: 1_000, callCount: 1, calls: [first] }], hasMore: false, nextCursor: null }));
  const requests = () => [...f.host.querySelectorAll('.jev-request-text')].map(node => node.textContent);
  assert.deepEqual(requests(), ['Request exec-2', 'Request exec-1']);
  await act(async () => emit({ type: 'call', call: summary('c3', 'exec-1', 3_000) }));
  await act(async () => emit({ type: 'call', call: summary('other', 'exec-9', 4_000, 'other-project') }));
  assert.deepEqual(requests(), ['Request exec-1', 'Request exec-2'], 'new activity moves its request first; other projects are ignored');
  assert.equal(f.host.querySelectorAll('.jev-request')[0]!.querySelectorAll('button.jev-call').length, 2);
  await act(async () => emit({ type: 'health', health: { ...HEALTHY_EVIDENCE_COLLECTOR, status: 'degraded',
    failures: { begin: 1, finish: 0, marker: 0 }, lastFailureAt: 5_000 } }));
  assert.match(f.host.querySelector('.jev-requests .routing-warning')?.textContent ?? '', /failing to save/,
    'collector health updates in place');
  assert.equal(loads, 1, 'no refetch of the Routing log');
  assert.equal(healthReads, 1);
});

test('rendered markdown is parsed once per body', () => {
  const body = 'A **bold** `code` @Ada ' + 'x'.repeat(20_000);
  assert.equal(renderBody(body), renderBody(body));
  assert.notEqual(renderBody(body), renderBody(body + '!'));
});

test('older search hits load one page at a time', async t => {
  const pages: Array<ReturnType<typeof deferred<{ hits: never[]; hasMore: boolean }>>> = [];
  const hit = (seq: number) => ({ seq, channelId: 'a', threadId: null, body: 'review', authorName: 'Ada', createdAt: seq }) as never;
  t.mock.method(api, 'search', (_q: string, _p: string, before?: number) => {
    if (before === undefined) return Promise.resolve({ hits: [hit(9)], hasMore: true });
    const next = deferred<{ hits: never[]; hasMore: boolean }>(); pages.push(next); return next.promise;
  });
  let search!: ReturnType<typeof useSearch>;
  function Harness() {
    search = useSearch({ selectedProject: 'alpha', projects: [{ slug: 'alpha' } as never], setErr: () => {} });
    return null;
  }
  const f = mount(t);
  await f.render(<Harness />);
  await act(async () => { search.setQuery('review'); });
  await act(async () => { search.searchNow(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.equal(search.hits.length, 1);
  search.loadOlderHits();
  search.loadOlderHits();
  assert.equal(pages.length, 1, 'a second click while loading does not start another request');
  await act(async () => { pages[0]!.resolve({ hits: [hit(5)], hasMore: false }); });
  assert.deepEqual(search.hits.map(h => (h as { seq: number }).seq), [9, 5]);
});
