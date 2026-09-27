import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Agent } from '../src/shared/types.ts';
import type { AgentOverview } from '../src/shared/agent-management.ts';
import type { TerminalState } from './use-terminal.ts';
import type { NativeMessage } from './native-bridge.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage,
  CustomEvent: window.CustomEvent, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { AgentPanel } = await import('./AgentPanel.tsx');
const { verifiedStopSession } = await import('./agent-runtime.ts');
const { LaunchSheet } = await import('./LaunchSheet.tsx');
const { api } = await import('./api.ts');
const { TERMINAL_EVENT } = await import('./native-bridge.ts');
const { resetTerminalHub } = await import('./use-terminal.ts');
after(() => window.happyDOM.close());
beforeEach(() => { document.body.innerHTML = ''; resetTerminalHub(); });

const agent: Agent = { id: 'a1', name: 'Atlas', role: 'brain', seniority: 'senior', focus: 'coord', online: true,
  lastSeenAt: 0, createdAt: 0, projectId: 'p1', project: 'acme', identityRevision: 2 };
const overview = (patch: Partial<AgentOverview> = {}): AgentOverview => ({ agent, identityRevision: 2, resumeAliases: [], profile: { type: 'fixed' },
  work: { task: null, assigned: 0, delegated: 0, toReview: 0 }, currentTask: null,
  inbox: { queued: { atLeast: 2, exact: true }, awaitingReceipt: 1, acknowledgedMessages: 5, lastAcknowledgedAt: null },
  traffic: { since: 100, bytes: 2048, calls: 3, routes: {} }, capability: null, lifecycle: [], ...patch });

async function mount(response: () => AgentOverview = overview, native = false) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const posted: NativeMessage[] = [];
  if (native) (window as typeof window & { webkit?: unknown }).webkit = { messageHandlers: { hivemind: {
    postMessage: (message: NativeMessage) => posted.push(message) } } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method, body });
    if (path === '/api/ui/session') return Response.json({ ok: true });
    if (path.endsWith('/overview')) return Response.json(response());
    if (path.endsWith('/identity')) return Response.json({ agent: response().agent, identityRevision: 3 });
    if (path.endsWith('/capability')) return Response.json({ capability: {
      workerId: 'a1', revision: 1, updatedAt: 1, lastEditorId: 'human', card: body && typeof body === 'object' && 'card' in body ? body.card : null } });
    if (path.endsWith('/remove-impact')) return Response.json({ agentId: 'a1', name: 'Atlas',
      cancelled: { count: 1, taskIds: ['t1'] }, unreviewed: { count: 2, taskIds: ['t2', 't3'] },
      terminalSession: null, launch: null, pendingLaunch: false, pendingNativeCleanup: false,
      impactToken: 'a'.repeat(64) });
    if (path.endsWith('/remove')) return Response.json({ agent: response().agent });
    if (path.endsWith('/runtime-event')) return Response.json({ event: { kind: (body as { kind: string }).kind } });
    return Response.json({ error: 'unexpected ' + path }, { status: 404 });
  };
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host as unknown as Element);
  let closed = false;
  let tick = 0;
  const render = () => <AgentPanel agentId="a1" agents={[agent]} projects={[]} tick={tick} onClose={() => { closed = true; }}
    onMessage={() => {}} onClear={() => {}} onResume={() => {}} onOpenTask={() => {}} onOpenThread={() => {}} onChanged={async () => {}} />;
  await act(async () => root.render(render()));
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  await settle();
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent?.trim() === label);
    assert.ok(button, label); await act(async () => button.click()); await settle();
  };
  const type = async (label: string, value: string) => {
    const input = Array.from(host.querySelectorAll('label')).find(item => item.firstChild?.textContent?.trim() === label)?.querySelector('input');
    assert.ok(input, label);
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event); });
  };
  return { host, calls, posted, click, type, closed: () => closed,
    fromApp: async (detail: object) => { await act(async () => window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail }))); },
    refresh: async () => { tick++; await act(async () => root.render(render())); await settle(); },
    cleanup: async () => {
    await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch;
    delete (window as typeof window & { webkit?: unknown }).webkit; resetTerminalHub();
  } };
}

test('fixed overview shows unknown launch config and saves only changed identity with its revision', async () => {
  const f = await mount();
  try {
    assert.match(f.host.textContent!, /Software and model: unknown/);
    assert.match(f.host.textContent!, /2 queued/);
    assert.match(f.host.textContent!, /2.0 KB returned across 3 calls since server start/);
    assert.equal(f.host.querySelector('button')?.getAttribute('aria-label'), 'Close dialog');
    await f.type('Focus', 'planning'); await f.click('Save identity');
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/identity')),
      { path: '/api/ui/agents/a1/identity', method: 'PATCH', body: { expectedRevision: 2, focus: 'planning' } });
  } finally { await f.cleanup(); }
});

test('remove previews exact task impact and sends the preview token on confirmation', async () => {
  const f = await mount();
  try {
    await f.click('Review removal impact…');
    assert.match(f.host.textContent!, /cancel 1 tasks and leave 2 tasks without a reviewer/);
    assert.match(f.host.textContent!, /t1/);
    await f.click('Confirm removal');
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/remove')),
      { path: '/api/ui/agents/a1/remove', method: 'POST', body: { impactToken: 'a'.repeat(64) } });
    assert.equal(f.closed(), true);
  } finally { await f.cleanup(); }
});

test('a realtime identity revision change blocks stale edits until the saved values are reloaded', async () => {
  let latest = overview();
  const f = await mount(() => latest);
  try {
    await f.type('Focus', 'planning');
    latest = overview({ agent: { ...agent, focus: 'review', identityRevision: 3 }, identityRevision: 3 });
    await f.refresh();
    assert.match(f.host.textContent!, /Current saved name: Atlas; focus: review/);
    await f.click('Save identity');
    assert.equal(f.calls.some(call => call.path.endsWith('/identity')), false);
    await f.click('Reload saved values');
    await f.type('Focus', 'planning'); await f.click('Save identity');
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/identity'))?.body,
      { expectedRevision: 3, focus: 'planning' });
  } finally { await f.cleanup(); }
});

test('worker capability editor sends the complete validated card and creation revision', async () => {
  const worker = { ...agent, role: 'worker' as const };
  const f = await mount(() => overview({ agent: worker }));
  try {
    await f.type('Capabilities (comma separated)', 'typescript, review');
    await f.type('Maximum in progress', '2');
    const mode = Array.from(f.host.querySelectorAll('label')).find(item => item.textContent?.includes('implementation'))?.querySelector('input');
    assert.ok(mode);
    await act(async () => mode.click());
    await f.click('Save capability');
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/capability')),
      { path: '/api/ui/agents/a1/capability', method: 'PUT', body: { expectedRevision: 0,
        card: { enabled: false, capabilities: ['typescript', 'review'], modes: ['implementation'], model: null,
          host: null, availableContext: null, availability: 'unavailable', maxInProgress: 2 } } });
  } finally { await f.cleanup(); }
});

test('stop requires a connected broker and unique live project/name ownership', () => {
  const session = { name: 'hm-acme-atlas', project: 'acme', agent: 'Atlas', alive: true, attached: 0, createdAt: 0 };
  const state: TerminalState = { native: true, platform: 'macos', tmux: 'available', broker: 'connected',
    sessions: [session], lastKnownSessions: [session], lastError: null };
  const seat = { ...agent, terminalSession: session.name };
  assert.equal(verifiedStopSession(seat, [seat], state), session.name);
  assert.equal(verifiedStopSession(seat, [seat], { ...state, broker: 'unavailable', sessions: null }), null);
  assert.equal(verifiedStopSession(seat, [seat, { ...seat, id: 'a2' }], state), null);
  assert.equal(verifiedStopSession(seat, [seat], { ...state, sessions: [{ ...session, agent: 'Other' }] }), null);
  const renamed = { ...seat, name: 'AtlasNew' };
  assert.equal(verifiedStopSession(renamed, [renamed], state, ['Atlas']), session.name,
    'a server-owned resume alias can identify the old native session');
  assert.equal(verifiedStopSession(renamed, [renamed], state, ['Foreign']), null);
});

test('fixed Stop waits for native kill acknowledgement before logging the observation', async () => {
  const withSession = { ...agent, terminalSession: 'hm-acme-atlas' };
  const f = await mount(() => overview({ agent: withSession }), true);
  try {
    await f.fromApp({ type: 'terminal-status', tmux: 'available', broker: 'connected', platform: 'macos' });
    await f.fromApp({ type: 'sessions', items: [{ name: 'hm-acme-atlas', project: 'acme', agent: 'Atlas',
      alive: true, attached: 0, createdAt: 0 }] });
    await f.click('Stop session…'); await f.click('Confirm Stop');
    const kill = f.posted.find(message => message.type === 'terminal-kill');
    assert.ok(kill && 'id' in kill);
    assert.equal(f.calls.filter(call => call.path.endsWith('/runtime-event')).length, 1,
      'only stop_requested is logged before the broker ACK');
    await f.fromApp({ type: 'terminal-killed', id: kill.id, session: 'hm-acme-atlas' });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/runtime-event')).map(call => call.body),
      [{ kind: 'stop_requested', session: 'hm-acme-atlas' }, { kind: 'stop_observed', session: 'hm-acme-atlas' }]);
    assert.match(f.host.textContent!, /closed by the native broker/);
  } finally { await f.cleanup(); }
});

test('targeted fixed resume selects exactly one agent and requires an explicit software choice', async () => {
  const originalContext = api.launchContext;
  api.launchContext = async () => ({ project: { id: 'p1', slug: 'acme' }, plugins: [], pluginInstructions: '',
    hivemindMcp: { command: 'hivemind', args: ['mcp'], env: {} } });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host as unknown as Element);
  try {
    await act(async () => root.render(<LaunchSheet projects={[{ id: 'p1', slug: 'acme', name: 'Acme',
      worktree: '/tmp/acme', createdAt: 0 }]} agents={[agent, { ...agent, id: 'a2', name: 'Bea' }]}
      defaultProject="acme" resumeAgentId="a1" onClose={() => {}} />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    const software = Array.from(host.querySelectorAll('label')).find(label => label.firstChild?.textContent?.trim() === 'Software')?.querySelector('input');
    assert.ok(software);
    assert.equal(software.value, '');
    assert.match(host.textContent!, /Resume Atlas only/);
    assert.doesNotMatch(host.textContent!, /From a template/);
    assert.equal(host.querySelectorAll('.launch-card').length, 1);
    const copy = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Copy all');
    assert.ok(copy?.disabled);
    const cardCopy = host.querySelector<HTMLButtonElement>('.launch-card button');
    assert.ok(cardCopy?.disabled, 'individual copy cannot bypass the target launch gate');
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(software, 'codex');
      software.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event); });
    assert.equal(copy.disabled, false);
    assert.equal(cardCopy.disabled, false);
  } finally {
    await act(async () => root.unmount()); host.remove(); api.launchContext = originalContext;
  }
});
