import type { Message } from '../src/shared/types.ts';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import type { ChannelPayload } from './api.ts';
import { retainNewest } from '../src/shared/realtime.ts';
import { boundLivePane } from './pane-window.ts';

/** Only the selected thread is retained; live events can precede its first HTTP response. */
export type ThreadView = {
  channelId: string;
  threadId: string;
  pane: ChannelPayload | null;
  pendingMessages: Message[];
  pendingTask?: TaskSnapshot;
  historyTruncated?: boolean;
  pendingLoad?: { id: number; liveMessages: Message[]; truncated?: boolean };
};

export function selectThread(view: ThreadView | null, channelId: string, threadId: string): ThreadView {
  return view?.channelId === channelId && view.threadId === threadId ? view :
    { channelId, threadId, pane: null, pendingMessages: [] };
}

export function beginThreadLoad(view: ThreadView | null, channelId: string, threadId: string, requestId: number): ThreadView {
  return { ...selectThread(view, channelId, threadId), pendingLoad: { id: requestId, liveMessages: [] } };
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

export function receiveThreadTask(view: ThreadView, task: TaskSnapshot): ThreadView {
  if (view.channelId !== task.channelId || view.threadId !== task.id) return view;
  if (!view.pane) return { ...view, pendingTask: reconcileTask(view.pendingTask, task) };
  return { ...view, pane: { ...view.pane, task: reconcileTask(view.pane.task, task) } };
}

export function receiveThreadSnapshot(view: ThreadView | null, threadId: string, data: ChannelPayload, requestId: number): ThreadView | null {
  if (!view || view.channelId !== data.channel.id || view.threadId !== threadId || view.pendingLoad?.id !== requestId) return view;
  const currentMessages = view.pane?.messages ?? view.pendingMessages;
  // HTTP refreshes pre-request metadata (including missed reactions while offline).
  // Only live updates received during THIS request take precedence over its snapshot.
  const messages = mergeMessages(mergeMessages(currentMessages, data.messages), view.pendingLoad.liveMessages);
  return {
    ...view, pendingMessages: [], pendingTask: undefined, pendingLoad: undefined,
    historyTruncated: undefined,
    pane: boundLivePane({ ...data, messages: messages.filter(message => belongs(view, message)),
      hasOlder: data.hasOlder || view.historyTruncated || view.pendingLoad.truncated,
      task: reconcileTask(view.pane?.task ?? view.pendingTask, data.task) }),
  };
}
