import { useCallback, useMemo } from "react";
import type { Agent, Message, ThreadStatus } from "../src/shared/types.ts";
import { api, type ChannelPayload } from "./api.ts";
import { Composer } from "./Composer.tsx";
import { channelTitle, STATUSES } from "./labels.ts";
import { BackButton } from "./MobileNav.tsx";
import { MessageRow } from "./MessageRow.tsx";
import { streamRows } from "./message-stream.ts";
import { holdLivePane, isReadingHistory } from "./pane-window.ts";
import { Popover } from "./Popover.tsx";
import { StreamDivider } from "./StreamCards.tsx";
import { TaskCard, TaskChip } from './TaskCard.tsx';
import type { useSend } from "./use-send.ts";
import type { ThreadPane } from "./use-thread-pane.ts";

/** The open side thread: status or task state, paged replies and the reply composer. */
export function ThreadAside({ channelId, threadId, threadPane, thread, onClose, roomAgents, compose }: {
  channelId: string;
  threadId: string;
  threadPane: ChannelPayload;
  thread: ThreadPane;
  onClose: () => void;
  roomAgents: Agent[];
  compose: ReturnType<typeof useSend>;
}) {
  const { threadStream, setThreadPane, onThreadMessage } = thread;
  const onReact = useCallback((m: Message, emoji: string) => {
    void api.react(m.seq, emoji, !m.reactions?.some(reaction => reaction.emoji === emoji && reaction.mine))
      .then((r) => onThreadMessage(r.message));
  }, [onThreadMessage]);
  const { sendThread } = compose;
  const onSend = useCallback((body: string, files: File[]) => sendThread(threadId, body, files), [sendThread, threadId]);
  const rows = useMemo(() => streamRows(threadPane.messages), [threadPane.messages]);
  return (
    <aside className="thread">
      <header className="desk-h">
        <BackButton label="Back to channel" onBack={onClose} />
        <div>
          <h1>Thread · {channelTitle(threadPane.channel)}</h1>
        </div>
        <div className="thread-tools">
          {threadPane.task ? <TaskChip state={threadPane.task.state} /> : <StatusMenu
            value={threadPane.threads.find((t) => t.id === threadId)?.status ?? "open"}
            onChange={(status) => thread.setStatus(channelId, threadId, status)}
          />}
          <button
            type="button"
            className="plus"
            aria-label="Close thread"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>
      {threadPane.historyThrough !== undefined && (
        <button type="button" className="older" onClick={() => thread.refreshThread(channelId, threadId)}>
          {threadPane.deferredLive ? "New replies — refresh thread" : "Refresh thread"}
        </button>
      )}
      <div className="stream" role="log" aria-label="Thread replies" ref={threadStream} onScroll={() => {
        if (isReadingHistory(threadStream.current)) setThreadPane((current) => current ? holdLivePane(current) : current);
      }}>
        {threadPane.task && <TaskCard task={threadPane.task} />}
        {threadPane.hasOlder && (
          <button type="button" className="older" onClick={() => thread.loadEarlier(threadPane, channelId, threadId)}>
            Load earlier replies
          </button>
        )}
        {rows.map((row) => row.type === "date" ? <StreamDivider key={row.key} label={row.label} /> : row.type === "new" ? null : (
          <MessageRow key={row.key} m={row.message} grouped={row.grouped} replies={0} status={null} onReact={onReact}
            taskRoute={row.message.taskEvent && threadPane.task?.id === row.message.taskEvent.taskId
              ? `${threadPane.task.assignerName} → ${threadPane.task.workerName}` : undefined} />
        ))}
        {threadPane.hasNewer && (
          <button type="button" className="older" onClick={() => thread.loadNewer(threadPane, channelId, threadId)}>
            Load more replies
          </button>
        )}
        <div />
      </div>
      <Composer
        agents={roomAgents}
        placeholder="Reply in thread…"
        onSend={onSend}
      />
    </aside>
  );
}

/** The thread status as a chip; its menu sets another status. */
export function StatusMenu({ value, onChange }: { value: ThreadStatus; onChange: (status: ThreadStatus) => void }) {
  const label = (status: ThreadStatus) => status.replace("_", " ");
  return (
    <Popover className="status-menu" label={`Thread status: ${label(value)}. Change status`}
      summary={<span className={`status-chip st-${value}`} data-thread-status={value}>{label(value)}</span>}>
      {(close) => (
        <div role="menu" aria-label="Thread status">
          {STATUSES.map((status) => (
            <button key={status} type="button" role="menuitemradio" aria-checked={status === value}
              onClick={() => { close(); if (status !== value) onChange(status); }}>
              <span className={`status-dot st-${status}`} aria-hidden="true" />{label(status)}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
