import type { Message, Thread } from '../src/shared/types.ts';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import type { ChannelPayload } from './api.ts';
import { retainNewest } from '../src/shared/realtime.ts';
import { boundLivePane } from './pane-window.ts';
import { mergeConfirmations } from './message-confirmations.ts';

/** Only the selected thread is retained; live events can precede its first HTTP response. */
export type ThreadView = {
  channelId: string;
  threadId: string;
  pane: ChannelPayload | null;
  pendingMessages: Message[];
  pendingTask?: TaskSnapshot;
  historyTruncated?: boolean;
  // Navigation intent outlives a single GET (replacement, reconnect or failure).
  returnToLive?: boolean;
  confirmations?: Message[];
  pendingLoad?: { id: number; liveMessages: Message[]; liveThread?: Thread; truncated?: boolean };
};

export function selectThread(view: ThreadView | null, channelId: string, threadId: string): ThreadView {
  return view?.channelId === channelId && view.threadId === threadId ? view :
    { channelId, threadId, pane: null, pendingMessages: [] };
}

export function beginThreadLoad(
  view: ThreadView | null, channelId: string, threadId: string, requestId: number,
  returnToLive = false, confirmations: Message[] = [],
): ThreadView {
  let current = selectThread(view, channelId, threadId);
  for (const message of confirmations) current = receiveThreadConfirmation(current, message);
  return { ...current, returnToLive: returnToLive || current.returnToLive,
    pendingLoad: { id: requestId, liveMessages: [] } };
}

/** Explicit history navigation cancels automatic return-to-live, not retained ACKs. */
export function cancelThreadLoad(view: ThreadView | null): ThreadView | null {
  return view ? { ...view, pendingLoad: undefined, returnToLive: undefined } : view;
}

export function failThreadLoad(view: ThreadView | null, requestId: number): ThreadView | null {
  return view?.pendingLoad?.id === requestId ? { ...view, pendingLoad: undefined } : view;
}

export function reconcileTask(current: TaskSnapshot | undefined, incoming: TaskSnapshot | undefined): TaskSnapshot | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  if (current.id !== incoming.id || current.channelId !== incoming.channelId) return incoming;
  let latest = incoming.revision >= current.revision ? incoming : current;
  // ACK does not increment revision. Keep it only for the same dispatch; a revised
  // contract/reassignment must still reset receipt, even if its state looks earlier.
  if (current.dispatchSeq !== incoming.dispatchSeq || current.workerId !== incoming.workerId) return latest;
  const incomingRoomRevision = incoming.room?.roomRevision ?? 0, currentRoomRevision = current.room?.roomRevision ?? 0;
  const room = incomingRoomRevision === currentRoomRevision ? latest.room : incomingRoomRevision > currentRoomRevision ? incoming.room : current.room;
  if (room && latest.room !== room) latest = { ...latest, room };
  const receivedAt = latest.receivedAt ?? current.receivedAt ?? incoming.receivedAt;
  return receivedAt === latest.receivedAt ? latest : {
    ...latest, receivedAt, state: latest.state === 'sent' ? 'delivered' : latest.state,
  };
}

function belongs(view: ThreadView, message: Message): boolean {
  return message.channelId === view.channelId && (message.id === view.threadId || message.threadId === view.threadId);
}

function mergeMessages(earlier: Message[], later: Message[]): Message[] {
  const byId = new Map(earlier.map(message => [message.id, message]));
  for (const message of later) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** Preserve fresher displayed metadata; ACKs never enter the in-flight live journal. */
export function receiveThreadConfirmation(view: ThreadView, message: Message): ThreadView {
  if (!belongs(view, message)) return view;
  const confirmations = mergeConfirmations(view.confirmations ?? [], [message]);
  if (!view.pane) {
    const pending = retainNewest(mergeMessages([message], view.pendingMessages));
    return { ...view, confirmations, pendingMessages: pending.items,
      historyTruncated: view.historyTruncated || pending.truncated };
  }
  return { ...view, confirmations,
    pane: boundLivePane({ ...view.pane, messages: mergeMessages([message], view.pane.messages) }) };
}

export function receiveThreadMessage(view: ThreadView, message: Message): ThreadView {
  if (!belongs(view, message)) return view;
  const live = view.pendingLoad && retainNewest(mergeMessages(view.pendingLoad.liveMessages, [message]));
  const pendingLoad = view.pendingLoad && live && {
    ...view.pendingLoad, liveMessages: live.items, truncated: view.pendingLoad.truncated || live.truncated,
  };
  if (!view.pane) {
    const pending = retainNewest(mergeMessages(view.pendingMessages, [message]));
    return { ...view, pendingLoad, pendingMessages: pending.items, historyTruncated: view.historyTruncated || pending.truncated };
  }
  return { ...view, pendingLoad, pane: boundLivePane({ ...view.pane, messages: mergeMessages(view.pane.messages, [message]) }) };
}

/** A status event belongs to the selected thread, including while HTTP is pending. */
export function receiveThreadStatus(view: ThreadView, thread: Thread): ThreadView {
  if (view.channelId !== thread.channelId || view.threadId !== thread.id) return view;
  const pendingLoad = view.pendingLoad ? { ...view.pendingLoad, liveThread: thread } : undefined;
  return { ...view, pendingLoad, pane: view.pane ? {
    ...view.pane, threads: [...view.pane.threads.filter(item => item.id !== thread.id), thread],
  } : null };
}

export function receiveThreadTask(view: ThreadView, task: TaskSnapshot): ThreadView {
  if (view.channelId !== task.channelId || view.threadId !== task.id) return view;
  if (!view.pane) return { ...view, pendingTask: reconcileTask(view.pendingTask, task) };
  return { ...view, pane: { ...view.pane, task: reconcileTask(view.pane.task, task) } };
}

export function receiveThreadSnapshot(view: ThreadView | null, threadId: string, data: ChannelPayload, requestId: number): ThreadView | null {
  if (!view || view.channelId !== data.channel.id || view.threadId !== threadId || view.pendingLoad?.id !== requestId) return view;
  const returnToLive = view.returnToLive;
  const currentMessages = returnToLive ? [] : view.pane?.messages ?? view.pendingMessages;
  // HTTP refreshes pre-request metadata (including missed reactions while offline).
  // Only live updates received during THIS request take precedence over its snapshot.
  const messages = mergeMessages(
    mergeMessages(mergeMessages(view.confirmations ?? [], currentMessages), data.messages),
    view.pendingLoad.liveMessages,
  );
  const liveThread = view.pendingLoad.liveThread;
  const threads = liveThread ? [...data.threads.filter(thread => thread.id !== liveThread.id), liveThread] : data.threads;
  return {
    ...view, pendingMessages: [], pendingTask: undefined, pendingLoad: undefined,
    historyTruncated: undefined, returnToLive: undefined, confirmations: undefined,
    pane: boundLivePane({ ...data, threads, historyThrough: returnToLive ? undefined : view.pane?.historyThrough,
      deferredLive: returnToLive ? undefined : view.pane?.deferredLive, messages: messages.filter(message => belongs(view, message)),
      hasOlder: data.hasOlder || (!returnToLive && view.historyTruncated) || view.pendingLoad.truncated,
      task: reconcileTask(view.pane?.task ?? view.pendingTask, data.task) }),
  };
}
