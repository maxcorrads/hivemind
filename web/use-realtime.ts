import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import type { AdaptiveExecutionState, AdaptiveRoutingEvent } from "../src/shared/adaptive-topology.ts";
import type { DecisionView } from '../src/shared/decisions.ts';
import type { createRequestGate } from "../src/shared/read-client.ts";
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import type { Agent, Channel, InboxStatus, Message, Thread } from "../src/shared/types.ts";
import { connectWs } from "./api.ts";
import { applyChannelMessage, recordChannelMessage, recordChannelThread } from "./channel-state.ts";
import { upsertById } from "./labels.ts";
import { holdLivePane, isReadingHistory } from "./pane-window.ts";
import { parseHash, type Sel } from "./selection.ts";
import { newerTelegramHealth, type TelegramHealth } from "./telegram-health.ts";
import { selectThread, receiveThreadStatus, receiveThreadTask } from './thread-state.ts';
import type { ChannelPane } from "./use-channel-pane.ts";
import type { HiveSnapshot } from "./use-hive-snapshot.ts";
import type { Selection } from "./use-selection.ts";
import type { ThreadPane } from "./use-thread-pane.ts";

/**
 * Loads the first snapshot and dispatches every WebSocket event into the
 * snapshot, panes, read state and view ticks. A `hello` (reconnect) or
 * `project` event drops every in-flight read and reloads from scratch.
 */
export function useRealtime({ selection, hive, channel, thread, inboxLoad, changeSelection, reopenDm, mergeMail,
  refreshRoutingView, onRoutingEvent, setErr }: {
  selection: Pick<Selection, "selRef" | "threadIdRef" | "viewingThread">;
  hive: HiveSnapshot;
  channel: ChannelPane;
  thread: ThreadPane;
  inboxLoad: MutableRefObject<ReturnType<typeof createRequestGate>>;
  changeSelection: (next: Sel) => void;
  reopenDm: (channelId: string) => void;
  mergeMail: (incoming: Message[]) => void;
  refreshRoutingView: (baseline?: boolean) => void;
  onRoutingEvent: (payload: { channelId: string; event: AdaptiveRoutingEvent; state: AdaptiveExecutionState | null }) => void;
  setErr: (error: string) => void;
}) {
  const { selRef, threadIdRef, viewingThread } = selection;
  const { setSnap, latestTelegramHealth, readFence, readRefresh, channelReads, threadReads, snapshotLoad,
    setReconnectTick, refreshSnap } = hive;
  const { setPane, channelStream, channelLoad, channelJournal, loadChannel } = channel;
  const { setThreadView, setThreadPane, threadLoad, loadThread, onThreadMessage } = thread;
  const [live, setLive] = useState(false);
  const [roomTick, setRoomTick] = useState(0);
  const [decisionTick, setDecisionTick] = useState(0);
  const [jevTick, setJevTick] = useState(0);

  const resetReadConnection = useCallback(() => {
    refreshRoutingView(true);
    readFence.current.reset();
    channelLoad.current.cancel();
    channelJournal.current = null;
    threadLoad.current.cancel();
    inboxLoad.current.cancel();
    channelReads.current?.reset();
    threadReads.current?.reset();
    setReconnectTick((value) => value + 1);
    refreshSnap().catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
  }, [refreshSnap, refreshRoutingView]);

  useEffect(() => {
    refreshSnap().catch((e) => { if (e?.name !== "AbortError") setErr(String(e.message || e)); });
    const off = connectWs((ev) => {
      if (ev.type === "hello") {
        resetReadConnection();
        setRoomTick(t => t + 1);
        return;
      }
      if (ev.type === "telegram-health") {
        const health = newerTelegramHealth(latestTelegramHealth.current, ev.payload as TelegramHealth);
        latestTelegramHealth.current = health;
        setSnap((current) => current ? { ...current, telegram: { running: false, configured: false, ...current.telegram, ...health } } : current);
        return;
      }
      if (ev.type === "jev-call") {
        if (selRef.current.kind === "jev") setJevTick(t => t + 1);
        return;
      }
      if (ev.type === "adaptive-routing") {
        onRoutingEvent(ev.payload as { channelId: string; event: AdaptiveRoutingEvent; state: AdaptiveExecutionState | null });
        return;
      }
      if (ev.type === "message") {
        const msg = ev.payload as Message;
        recordChannelMessage(channelJournal.current, msg);
        setPane((p) => applyChannelMessage(p && isReadingHistory(channelStream.current) ? holdLivePane(p) : p, msg));
        onThreadMessage(msg);
        readFence.current.observe(msg.seq);
        readRefresh.current?.request();
        reopenDm(msg.channelId);
        mergeMail([msg]);
        return;
      }
      if (ev.type === "reaction") {
        const payload = ev.payload as { message?: Message };
        if (payload.message) {
          recordChannelMessage(channelJournal.current, payload.message, false);
          setPane((p) => applyChannelMessage(p, payload.message!, false));
          onThreadMessage(payload.message);
        }
        return;
      }
      if (ev.type === "agent") {
        const agent = ev.payload as Agent;
        setSnap((s) => (s ? { ...s, agents: upsertById(s.agents, agent) } : s));
        return;
      }
      if (ev.type === "channel") {
        const ch = ev.payload as Channel;
        setSnap((s) => (s ? { ...s, channels: upsertById(s.channels, ch) } : s));
        return;
      }
      if (ev.type === "thread") {
        const thread = ev.payload as Thread;
        recordChannelThread(channelJournal.current, thread);
        if (viewingThread(thread.channelId, thread.id))
          setThreadView(view => receiveThreadStatus(selectThread(view, thread.channelId, thread.id), thread));
        setPane((p) => {
          if (!p || p.channel.id !== thread.channelId || !p.messages.some((message) => message.id === thread.id)) return p;
          return { ...p, threads: upsertById(p.threads, thread) };
        });
        return;
      }
      if (ev.type === "queued") {
        const q = ev.payload as { agentId: string; n: number; inbox?: InboxStatus };
        if (selRef.current.kind === 'decisions') setDecisionTick(t => t + 1);
        setSnap((current) => {
          if (!current) return current;
          const previous = current.inbox?.[q.agentId];
          const inbox: InboxStatus = q.inbox ?? {
            awaitingReceipt: previous?.awaitingReceipt ?? 0,
            acknowledgedMessages: previous?.acknowledgedMessages ?? 0,
            lastAcknowledgedAt: previous?.lastAcknowledgedAt ?? null,
            queued: { atLeast: q.n, exact: true },
          };
          return {
            ...current,
            queued: { ...current.queued, [q.agentId]: q.n },
            inbox: { ...current.inbox, [q.agentId]: inbox },
          };
        });
        return;
      }
      if (ev.type === 'task') {
        const task = ev.payload as TaskSnapshot;
        setDecisionTick(t => t + 1);
        if (selRef.current.kind === 'channel' && selRef.current.id === task.channelId) setRoomTick(t => t + 1);
        if (viewingThread(task.channelId, task.id)) {
          setThreadView(view => receiveThreadTask(selectThread(view, task.channelId, task.id), task));
          loadThread(task.channelId, task.id).catch(() => undefined);
        }
        return;
      }
      if (ev.type === 'decision') {
        const decision = ev.payload as DecisionView;
        setDecisionTick(t => t + 1);
        if (selRef.current.kind === 'channel' && selRef.current.id === decision.channelId) {
          const root = threadIdRef.current;
          if (root === decision.id || root === decision.taskId)
            loadThread(decision.channelId, root).catch(() => undefined);
        }
        return;
      }
      if (ev.type === 'room') {
        const payload = ev.payload as { channelId: string };
        if (selRef.current.kind === 'channel' && selRef.current.id === payload.channelId) {
          setRoomTick(t => t + 1);
          if (threadIdRef.current) loadThread(payload.channelId, threadIdRef.current).catch(() => undefined);
        }
        return;
      }
      if (ev.type === "project") {
        resetReadConnection();
        return;
      }
    }, setLive);
    const onHash = () => changeSelection(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      off();
      channelLoad.current.cancel();
      channelJournal.current = null;
      threadLoad.current.cancel();
      snapshotLoad.current.cancel();
      inboxLoad.current.cancel();
      window.removeEventListener("hashchange", onHash);
    };
  }, [loadChannel, refreshSnap, resetReadConnection, changeSelection, onThreadMessage, viewingThread, loadThread, setThreadPane]);

  return { live, roomTick, setRoomTick, decisionTick, setDecisionTick, jevTick };
}
