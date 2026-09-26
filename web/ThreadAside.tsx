import { Fragment, useCallback, useMemo } from "react";
import { ChevronDown, X } from "lucide-react";
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
  // The snapshot's count misses live replies and a paged pane misses older ones: show the larger.
  const loadedReplies = threadPane.messages.filter((m) => m.threadId === threadId).length;
  const replyCount = Math.max(threadPane.replyCounts[threadId] ?? 0, loadedReplies);
  const firstReply = rows.findIndex((row) => row.type === "message" && row.message.threadId === threadId);
  return (
    <aside className="thread">
      <header className="desk-h thread-h">
        <BackButton label="Back to channel" onBack={onClose} />
        <div>
          <h1>Thread<span className="sr-only"> · </span><span className="thread-where">{channelTitle(threadPane.channel)}</span></h1>
        </div>
        <div className="thread-tools">
          {threadPane.task ? <TaskChip state={threadPane.task.state} /> : <StatusMenu
            value={threadPane.threads.find((t) => t.id === threadId)?.status ?? "open"}
            onChange={(status) => thread.setStatus(channelId, threadId, status)}
          />}
          <button type="button" className="icon-btn thread-close" aria-label="Close thread" title="Close thread" onClick={onClose}>
            <X size={16} aria-hidden="true" />
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
        {rows.map((row, index) => row.type === "date" ? <StreamDivider key={row.key} label={row.label} /> : row.type === "new" ? null : (
          <Fragment key={row.key}>
            {index === firstReply && <RepliesDivider count={replyCount} />}
            <MessageRow m={row.message} grouped={row.grouped && index !== firstReply} replies={0} status={null} onReact={onReact}
              taskRoute={row.message.taskEvent && threadPane.task?.id === row.message.taskEvent.taskId
                ? `${threadPane.task.assignerName} → ${threadPane.task.workerName}` : undefined} />
          </Fragment>
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
        compact
      />
    </aside>
  );
}

/** "N replies" and a hairline, between the root message and its first reply. */
function RepliesDivider({ count }: { count: number }) {
  const label = `${count} ${count === 1 ? "reply" : "replies"}`;
  return <div className="thread-replies" role="separator" aria-label={label}><span>{label}</span></div>;
}

/** The thread status as a chip; its menu sets another status. */
export function StatusMenu({ value, onChange }: { value: ThreadStatus; onChange: (status: ThreadStatus) => void }) {
  const label = (status: ThreadStatus) => status.replace("_", " ");
  const shown = (status: ThreadStatus) => label(status).replace(/^./, (c) => c.toUpperCase());
  return (
    <Popover className="status-menu" label={`Thread status: ${label(value)}. Change status`}
      summary={<span className={`status-chip st-${value}`} data-thread-status={value}>
        <span className={`status-dot st-${value}`} aria-hidden="true" />{shown(value)}<ChevronDown size={12} aria-hidden="true" />
      </span>}>
      {(close) => (
        <div role="menu" aria-label="Thread status">
          {STATUSES.map((status) => (
            <button key={status} type="button" role="menuitemradio" aria-checked={status === value}
              onClick={() => { close(); if (status !== value) onChange(status); }}>
              <span className={`status-dot st-${status}`} aria-hidden="true" />{shown(status)}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
