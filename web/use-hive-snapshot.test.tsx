import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { api, type Snapshot } from './api.ts';
import { useHiveSnapshot, type HiveSnapshot } from './use-hive-snapshot.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

function snapshot(archivedChannelIds?: string[]): Snapshot {
  const you: Snapshot['you'] = { id: 'human', name: 'Human', role: 'human', seniority: null, focus: null,
    online: true, lastSeenAt: 1, createdAt: 1, projectId: null, project: null };
  return { you, agents: [you], channels: [], projects: [], queued: {}, inbox: {}, archivedChannelIds,
    readInstance: 'fixture', readRevision: 1, readSeq: 1, unread: {}, mentions: [], mentionsHasMore: false, mentionCounts: {} };
}

async function fixture(t: TestContext) {
  type Request = { signal?: AbortSignal; resolve: (value: Snapshot) => void; reject: (error: Error) => void };
  const requests: Request[] = [];
  // Intentionally allow completion after abort to exercise the logical fence,
  // not just fetch's cancellation behavior.
  t.mock.method(api, 'snapshot', (signal?: AbortSignal) => new Promise<Snapshot>((resolve, reject) => {
    requests.push({ signal, resolve, reject });
  }));
  let current!: HiveSnapshot;
  const errors: string[] = [];
  function Harness() { current = useHiveSnapshot(error => errors.push(error)); return null; }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); host.remove(); } };
  t.after(unmount);
  await act(async () => root.render(<Harness />));
  return {
    get hive() { return current; }, errors, unmount,
    load(kind: 'refreshSnap' | 'refreshArchivedChannels') {
      const pending = current[kind]();
      const request = requests.at(-1)!;
      return { signal: request.signal,
        finish: async (value: Snapshot) => { await act(async () => { request.resolve(value); await pending; }); },
        fail: async (error: Error) => { await act(async () => { request.reject(error); await assert.rejects(pending, error); }); },
      };
    },
  };
}

test('room-only refresh preserves roster, queues and read state updated while its response is pending', async t => {
  const f = await fixture(t);
  await f.load('refreshSnap').finish(snapshot([]));
  const room = f.load('refreshArchivedChannels');
  await act(async () => f.hive.setSnap(previous => ({ ...previous!,
    agents: [{ ...previous!.you, online: false, lastSeenAt: 2 }], queued: { worker: 7 },
    inbox: { worker: { awaitingReceipt: 3, acknowledgedMessages: 2, lastAcknowledgedAt: 4, queued: { atLeast: 7, exact: true } } },
    readRevision: 4, readSeq: 9, unread: { channel: 5 }, mentionCounts: { channel: 3 },
  })));
  const live = f.hive.snap;
  await room.finish(snapshot(['archived']));
  assert.deepEqual(f.hive.snap, { ...live, archivedChannelIds: ['archived'] });
  assert.deepEqual(f.errors, []);
});

test('later room requests supersede delayed archive/reopen responses', async t => {
  const f = await fixture(t);
  await f.load('refreshSnap').finish(snapshot([]));
  const archive = f.load('refreshArchivedChannels');
  const reopen = f.load('refreshArchivedChannels');
  assert.equal(archive.signal?.aborted, true);
  await reopen.finish(snapshot([]));
  await archive.finish(snapshot(['room']));
  assert.deepEqual(f.hive.snap?.archivedChannelIds, []);
});

for (const roomFirst of [true, false]) {
  test(`room metadata survives an overlapping initial snapshot (room finishes ${roomFirst ? 'first' : 'last'})`, async t => {
    const f = await fixture(t);
    const full = f.load('refreshSnap');
    const room = f.load('refreshArchivedChannels');
    if (roomFirst) {
      await room.finish(snapshot(['room']));
      assert.equal(f.hive.snap, null, 'a partial refresh cannot initialize the hive');
      await full.finish(snapshot([]));
    } else {
      await full.finish(snapshot([]));
      await room.finish(snapshot(['room']));
    }
    assert.deepEqual(f.hive.snap?.archivedChannelIds, ['room']);
  });

  test(`a reconnect supersedes old room responses (old room finishes ${roomFirst ? 'first' : 'last'})`, async t => {
    const f = await fixture(t);
    await f.load('refreshSnap').finish(snapshot(['room']));
    const room = f.load('refreshArchivedChannels');
    f.hive.readFence.current.reset();
    const reconnect = f.load('refreshSnap');
    if (roomFirst) await room.finish(snapshot(['room']));
    await reconnect.finish(snapshot([]));
    assert.equal(room.signal?.aborted, true);
    if (!roomFirst) await room.finish(snapshot(['room']));
    assert.deepEqual(f.hive.snap?.archivedChannelIds, []);
  });
}

test('failed and aborted room loads preserve state; a later refresh and old servers remain supported', async t => {
  const f = await fixture(t);
  await f.load('refreshSnap').finish(snapshot(['room']));
  const before = f.hive.snap;
  await f.load('refreshArchivedChannels').fail(new Error('Fixture offline'));
  assert.deepEqual(f.hive.snap, before);
  await f.load('refreshArchivedChannels').finish(snapshot([]));
  assert.deepEqual(f.hive.snap?.archivedChannelIds, []);
  await f.load('refreshArchivedChannels').finish(snapshot());
  assert.equal(f.hive.snap?.archivedChannelIds, undefined);
  const pending = f.load('refreshArchivedChannels');
  const final = f.hive.snap;
  await f.unmount();
  assert.equal(pending.signal?.aborted, true);
  await pending.finish(snapshot(['room']));
  assert.deepEqual(f.hive.snap, final);
});

for (const initialized of [false, true]) {
  for (const failureFirst of [false, true]) {
    test(`failed room refresh retains successful ${initialized ? 'replacement' : 'initial'} archive metadata (failure first: ${failureFirst})`, async t => {
      const f = await fixture(t);
      if (initialized) await f.load('refreshSnap').finish(snapshot(['old-archive']));
      const full = f.load('refreshSnap');
      const room = f.load('refreshArchivedChannels');
      if (failureFirst) await room.fail(new Error('Fixture offline'));
      await full.finish(snapshot(['current-archive']));
      if (!failureFirst) await room.fail(new Error('Fixture offline'));
      assert.deepEqual(f.hive.snap?.archivedChannelIds, ['current-archive']);
    });
  }
}

for (const ids of [[], undefined]) {
  test(`a failed later request cannot roll back successfully received ${ids ? 'empty' : 'missing'} archive metadata`, async t => {
    const f = await fixture(t);
    const full = f.load('refreshSnap');
    await f.load('refreshArchivedChannels').finish(snapshot(ids));
    await f.load('refreshArchivedChannels').fail(new Error('Fixture offline'));
    await full.finish(snapshot(['stale-archive']));
    assert.equal(f.hive.snap?.archivedChannelIds, ids);
  });
}

test('a failed full refresh does not abort a pending room refresh', async t => {
  const f = await fixture(t);
  await f.load('refreshSnap').finish(snapshot([]));
  const room = f.load('refreshArchivedChannels');
  await f.load('refreshSnap').fail(new Error('Fixture offline'));
  assert.equal(room.signal?.aborted, false);
  await room.finish(snapshot(['room']));
  assert.deepEqual(f.hive.snap?.archivedChannelIds, ['room']);
});

test('an accepted full refresh aborts and supersedes an older pending room refresh', async t => {
  const f = await fixture(t);
  await f.load('refreshSnap').finish(snapshot([]));
  const room = f.load('refreshArchivedChannels');
  const full = f.load('refreshSnap');
  assert.equal(room.signal?.aborted, false);
  await full.finish(snapshot(['current']));
  assert.equal(room.signal?.aborted, true);
  await room.finish(snapshot(['stale']));
  assert.deepEqual(f.hive.snap?.archivedChannelIds, ['current']);
});
