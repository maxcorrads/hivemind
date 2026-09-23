import { useCallback, useEffect, useRef, useState } from "react";
import type { ReadSnapshot } from "../src/shared/read-state.ts";
import { createReadFence, createReadRefresh, createReceiptQueue, createRequestGate, readFields } from "../src/shared/read-client.ts";
import { api, type Snapshot } from "./api.ts";
import { newerTelegramHealth, type TelegramHealth } from "./telegram-health.ts";

/**
 * The hive snapshot plus the read-state fence, refresh and receipt queues that
 * keep its unread counts consistent with what the Human has actually seen.
 */
export function useHiveSnapshot(setErr: (error: string) => void) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const latestTelegramHealth = useRef<TelegramHealth | null>(null);
  const readFence = useRef(createReadFence());
  const snapshotLoad = useRef(createRequestGate());
  const readRefresh = useRef<ReturnType<typeof createReadRefresh> | null>(null);
  const channelReads = useRef<ReturnType<typeof createReceiptQueue> | null>(null);
  const threadReads = useRef<ReturnType<typeof createReceiptQueue> | null>(null);
  const [readTick, setReadTick] = useState(0);
  const [reconnectTick, setReconnectTick] = useState(0);
  const readVersion = useRef("");

  const acceptRead = useCallback((next: ReadSnapshot, ticket: number) => {
    if (!readFence.current.accept(next, ticket)) return false;
    setSnap((previous) => previous ? { ...previous, ...readFields(next) } : previous);
    const version = JSON.stringify([ticket, next.readInstance, next.readRevision, next.readSeq]);
    if (readVersion.current !== version) {
      readVersion.current = version;
      setReadTick((value) => value + 1);
    }
    return true;
  }, []);

  useEffect(() => {
    const later = (run: () => void) => {
      const timer = window.setTimeout(run, 16);
      return () => window.clearTimeout(timer);
    };
    const onError = (error: unknown) => setErr(String(error));
    const refresh = createReadRefresh(async (signal) => {
      const ticket = readFence.current.ticket();
      const next = await api.readState(signal);
      if (!signal.aborted && !acceptRead(next, ticket) && readFence.current.current(ticket)) refresh.request();
    }, later, onError);
    const makeQueue = () => createReceiptQueue(async (scope, seqs, signal) => {
      const ticket = readFence.current.ticket();
      const next = await api.markMessagesSeen(scope.channelId, scope.threadId, seqs, signal);
      if (!signal.aborted && !acceptRead(next, ticket)) refresh.request();
    }, later, onError);
    readRefresh.current = refresh;
    channelReads.current = makeQueue();
    threadReads.current = makeQueue();
    return () => {
      readFence.current.reset();
      refresh.dispose();
      channelReads.current?.dispose();
      threadReads.current?.dispose();
      readRefresh.current = null;
      channelReads.current = null;
      threadReads.current = null;
    };
  }, [acceptRead]);

  const refreshSnap = useCallback(async () => {
    const load = snapshotLoad.current.begin();
    const ticket = readFence.current.ticket();
    const raw = await api.snapshot(load.signal);
    latestTelegramHealth.current = newerTelegramHealth(latestTelegramHealth.current, raw.telegram);
    const next = { ...raw, telegram: { running: false, configured: false, ...raw.telegram, ...latestTelegramHealth.current } };
    if (!load.valid() || !readFence.current.current(ticket)) return next;
    const accepted = acceptRead(next, ticket);
    setSnap((previous) => ({ ...next, ...(!accepted && previous ? readFields(previous) : {}) }));
    if (!accepted) readRefresh.current?.request();
    return next;
  }, [acceptRead]);

  return {
    snap, setSnap, latestTelegramHealth, readFence, snapshotLoad, readRefresh, channelReads, threadReads,
    readTick, reconnectTick, setReconnectTick, acceptRead, refreshSnap,
  };
}

export type HiveSnapshot = ReturnType<typeof useHiveSnapshot>;
