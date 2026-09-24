import type { Message, Thread } from "../src/shared/types.ts";
import { LIVE_MESSAGE_WINDOW } from "../src/shared/realtime.ts";
import type { ChannelPayload } from "./api.ts";
import { boundLivePane } from "./pane-window.ts";

/** Owned by one cancellable HTTP request, never by the lifetime of the app. */
export type ChannelJournal = {
  channelId: string;
  messages: Map<string, { message: Message; inserted: boolean }>;
  threads: Map<string, Thread>;
  confirmations: Map<string, Message>;
  overflow: boolean;
};

export function beginChannelJournal(channelId: string, confirmations: Message[] = []): ChannelJournal {
  const journal: ChannelJournal = { channelId, messages: new Map(), threads: new Map(), confirmations: new Map(), overflow: false };
  for (const message of confirmations) recordChannelConfirmation(journal, message);
  return journal;
}

/** A send response is a missing-ID fallback, even when received during a GET. */
export function recordChannelConfirmation(journal: ChannelJournal | null, message: Message): void {
  if (!journal || journal.channelId !== message.channelId) return;
  journal.confirmations.set(message.id, message);
  boundJournal(journal, journal.confirmations);
}

function boundJournal<T>(journal: ChannelJournal, entries: Map<string, T>): void {
  if (entries.size <= LIVE_MESSAGE_WINDOW) return;
  entries.delete(entries.keys().next().value!);
  journal.overflow = true;
}

export function recordChannelMessage(journal: ChannelJournal | null, message: Message, inserted = true): void {
  if (!journal || journal.channelId !== message.channelId) return;
  const previous = journal.messages.get(message.id);
  // A late send acknowledgement/duplicate message must not undo a reaction.
  journal.messages.set(message.id, {
    message: inserted && previous ? previous.message : message,
    inserted: inserted || Boolean(previous?.inserted),
  });
  boundJournal(journal, journal.messages);
}

export function recordChannelThread(journal: ChannelJournal | null, thread: Thread): void {
  if (!journal || journal.channelId !== thread.channelId) return;
  journal.threads.set(thread.id, thread);
  boundJournal(journal, journal.threads);
}

export function applyChannelMessage(pane: ChannelPayload | null, message: Message, inserted = true): ChannelPayload | null {
  if (!pane || pane.channel.id !== message.channelId || pane.threadId !== null) return pane;
  if (message.threadId) {
    if (!inserted || !pane.messages.some(root => root.id === message.threadId)) return pane;
    const through = Math.max(pane.snapshotSeq ?? 0, pane.replySeqs?.[message.threadId] ?? 0);
    if (message.seq <= through) return pane;
    return { ...pane,
      replyCounts: { ...pane.replyCounts, [message.threadId]: (pane.replyCounts[message.threadId] ?? 0) + 1 },
      replySeqs: { ...pane.replySeqs, [message.threadId]: message.seq },
    };
  }
  const exists = pane.messages.some(item => item.id === message.id);
  if (inserted && exists || !inserted && !exists) return pane;
  const messages = exists ? pane.messages.map(item => item.id === message.id ? message : item)
    : [...pane.messages, message].sort((a, b) => a.seq - b.seq);
  return boundLivePane({ ...pane, messages });
}

/** Snapshot refreshes pre-request data; only this request's live updates win. */
export function reconcileChannelSnapshot(
  current: ChannelPayload | null, data: ChannelPayload, journal: ChannelJournal, older = false, returnToLive = false,
): ChannelPayload | null {
  if (data.channel.id !== journal.channelId || data.threadId !== null) return current;
  // Never install a partially replayed snapshot and silently erase live state.
  // The caller retries with a fresh bounded journal (at most three attempts).
  if (journal.overflow) throw new Error("Channel refresh exceeded its live event window");
  const previous = current?.channel.id === data.channel.id ? current : null;
  const held = !returnToLive && previous?.historyThrough !== undefined;
  const byId = new Map((held || older ? previous?.messages ?? [] : []).map(message => [message.id, message]));
  for (const message of journal.confirmations.values()) {
    if (!message.threadId && !byId.has(message.id)) byId.set(message.id, message);
  }
  for (const message of data.messages) byId.set(message.id, message);
  for (const { message, inserted } of journal.messages.values()) {
    if (!message.threadId && (inserted || byId.has(message.id))) byId.set(message.id, message);
  }
  // The server scopes thread aggregates to the page it returns. Roots kept from the previous window
  // (older pages, held history) keep their counts and statuses, which live events already updated.
  const dataRoots = new Set(data.messages.map(message => message.id));
  const carry = <T,>(values: Record<string, T> | undefined) => held || older
    ? Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => byId.has(id) && !dataRoots.has(id))) : {};
  const carried = carry(previous?.replyCounts);
  const counts = { ...carried, ...data.replyCounts };
  const replySeqs: Record<string, number> = carry(previous?.replySeqs);
  // Count each insertion once across ACK + WS, including a reply missing from
  // the snapshot. A reaction-only entry must not erase proof of insertion.
  const insertions = new Map(journal.confirmations);
  for (const { message, inserted } of journal.messages.values()) {
    if (inserted) insertions.set(message.id, message);
  }
  for (const message of insertions.values()) {
    if (!message.threadId || message.threadId in carried) continue;
    if (data.snapshotSeq === undefined) {
      // Older/mock payloads lack a sequence fence; avoid duplicate counts.
      counts[message.threadId] = Math.max(counts[message.threadId] ?? 0, previous?.replyCounts[message.threadId] ?? 0);
    } else if (message.seq > data.snapshotSeq) {
      counts[message.threadId] = (counts[message.threadId] ?? 0) + 1;
      replySeqs[message.threadId] = Math.max(replySeqs[message.threadId] ?? 0, message.seq);
    }
  }
  const threads = new Map([...(held || older ? previous?.threads ?? [] : []).filter(thread => !dataRoots.has(thread.id)), ...data.threads]
    .map(thread => [thread.id, thread]));
  for (const thread of journal.threads.values()) threads.set(thread.id, thread);
  const pane = boundLivePane({ ...data,
    messages: [...byId.values()].sort((a, b) => a.seq - b.seq),
    historyThrough: held ? previous!.historyThrough : undefined,
    deferredLive: held ? previous!.deferredLive : undefined,
    hasOlder: older ? data.hasOlder : held ? previous!.hasOlder : data.hasOlder,
    hasNewer: held ? previous!.hasNewer : data.hasNewer,
    cursors: held ? { ...previous!.cursors, ...(older ? { before: data.cursors?.before } : {}) } : data.cursors,
    threads: [...threads.values()], replyCounts: counts, replySeqs,
  });
  const roots = new Set(pane.messages.map(message => message.id));
  return { ...pane, threads: pane.threads.filter(thread => roots.has(thread.id)),
    replyCounts: Object.fromEntries(Object.entries(pane.replyCounts).filter(([id]) => roots.has(id))),
    replySeqs: Object.fromEntries(Object.entries(pane.replySeqs ?? {}).filter(([id]) => roots.has(id))),
  };
}
