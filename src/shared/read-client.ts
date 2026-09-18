import type { ReadSnapshot, ReadStamp } from "./read-state.ts";

export function readFields(snapshot: ReadSnapshot): ReadSnapshot {
  const { readInstance, readRevision, readSeq, unread, mentions, mentionsHasMore, mentionCounts } = snapshot;
  return { readInstance, readRevision, readSeq, unread, mentions, mentionsHasMore, mentionCounts };
}

/** Order only read-state responses, not general conversation/roster snapshots. */
export function createReadFence() {
  let epoch = 0;
  let instance: string | null = null;
  let revision = -1;
  let seq = 0;
  const matches = (stamp: ReadStamp, ticket: number) => ticket === epoch &&
    (!instance || instance === stamp.readInstance) && stamp.readRevision >= revision && stamp.readSeq >= seq;
  return {
    ticket: () => epoch,
    current: (ticket: number) => ticket === epoch,
    observe: (value: number) => { seq = Math.max(seq, value); },
    matches,
    accept: (stamp: ReadStamp, ticket: number) => {
      if (!matches(stamp, ticket)) return false;
      instance = stamp.readInstance;
      revision = stamp.readRevision;
      seq = stamp.readSeq;
      return true;
    },
    reset: () => { epoch++; instance = null; revision = -1; seq = 0; },
  };
}

export type ReadScope = { channelId: string; threadId: string | null };
type Defer = (run: () => void) => () => void;

/** One request and one replaceable pending window per rendered pane. */
export function createReceiptQueue(
  send: (scope: ReadScope, seqs: number[], signal: AbortSignal) => Promise<void>,
  defer: Defer,
  onError: (error: unknown) => void,
) {
  let scope: ReadScope | null = null;
  let key = "";
  let generation = 0;
  let pending: number[] = [];
  const seen = new Set<number>();
  let active: AbortController | null = null;
  let cancel: (() => void) | null = null;
  let stopped = false;
  const reset = () => {
    generation++;
    cancel?.(); cancel = null;
    active?.abort(); active = null;
    seen.clear(); pending = [];
  };
  const schedule = () => {
    if (stopped || cancel || active || !scope || !pending.some((seq) => !seen.has(seq))) return;
    const version = generation;
    cancel = defer(() => {
      if (stopped || version !== generation || !scope) return;
      cancel = null;
      const batch = pending.filter((seq) => !seen.has(seq)).slice(0, 200);
      if (!batch.length) return;
      const controller = new AbortController();
      const selected = scope;
      active = controller;
      Promise.resolve().then(() => {
        if (controller.signal.aborted) return;
        return send(selected, batch, controller.signal);
      }).then(() => {
        if (stopped || controller.signal.aborted || version !== generation) return;
        for (const seq of batch) if (pending.includes(seq)) seen.add(seq);
        active = null;
        schedule();
      }).catch((error: unknown) => {
        if (stopped || controller.signal.aborted || version !== generation) return;
        active = null;
        onError(error); // A new visible update/reconnect retries; no infinite error loop.
      });
    });
  };
  return {
    update: (next: ReadScope | null, seqs: number[]) => {
      if (stopped) return;
      const nextKey = next ? JSON.stringify([next.channelId, next.threadId]) : "";
      if (nextKey !== key) { reset(); key = nextKey; }
      scope = next;
      pending = next ? [...new Set(seqs)] : [];
      const retained = new Set(pending);
      for (const seq of seen) if (!retained.has(seq)) seen.delete(seq);
      schedule();
    },
    reset: () => { reset(); key = ""; scope = null; },
    dispose: () => { stopped = true; reset(); scope = null; },
  };
}

/** Burst-coalesced read-only refresh, with a single trailing request if dirty. */
export function createReadRefresh(
  fetch: (signal: AbortSignal) => Promise<void>,
  defer: Defer,
  onError: (error: unknown) => void,
) {
  let stopped = false;
  let dirty = false;
  let cancel: (() => void) | null = null;
  let active: AbortController | null = null;
  const request = () => {
    if (stopped) return;
    dirty = true;
    if (active || cancel) return;
    cancel = defer(() => {
      cancel = null;
      if (stopped) return;
      dirty = false;
      const controller = new AbortController();
      active = controller;
      Promise.resolve().then(() => { if (!stopped && !controller.signal.aborted) return fetch(controller.signal); }).catch((error: unknown) => {
        if (!stopped && !controller.signal.aborted) onError(error);
      }).finally(() => {
        active = null;
        if (!stopped && dirty) request();
      });
    });
  };
  return {
    request,
    dispose: () => { stopped = true; cancel?.(); active?.abort(); cancel = null; dirty = false; },
  };
}

/** Capture navigation/request ownership before awaiting an HTTP response. */
export function createRequestGate() {
  let generation = 0;
  let controller: AbortController | null = null;
  const cancel = () => { generation++; controller?.abort(); controller = null; };
  return {
    cancel,
    begin: () => {
      cancel();
      const current = generation;
      controller = new AbortController();
      const signal = controller.signal;
      return { signal, valid: () => !signal.aborted && current === generation };
    },
  };
}
