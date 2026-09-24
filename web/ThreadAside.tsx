import { useCallback, useMemo } from "react";
import type { Agent, Message, ThreadStatus } from "../src/shared/types.ts";
import { api, type ChannelPayload } from "./api.ts";
import { Composer } from "./Composer.tsx";
import { DecisionCard } from './DecisionQueue.tsx';
import { STATUSES } from "./labels.ts";
import { BackButton } from "./MobileNav.tsx";
import { MessageRow } from "./MessageRow.tsx";
import { streamRows } from "./message-stream.ts";
import { holdLivePane, isReadingHistory } from "./pane-window.ts";
import { StreamDivider } from "./StreamCards.tsx";
import { TaskCard } from './TaskCard.tsx';
import type { useSend } from "./use-send.ts";
import type { ThreadPane } from "./use-thread-pane.ts";

/** The open side thread: status or task state, decision card, paged replies and the reply composer. */
export function ThreadAside({ channelId, threadId, threadPane, thread, onClose, onDecisionAnswered, roomAgents, compose }: {
  channelId: string;
  threadId: string;
  threadPane: ChannelPayload;
  thread: ThreadPane;
  onClose: () => void;
  onDecisionAnswered: () => void;
  roomAgents: Agent[];
  compose: ReturnType<typeof useSend>;
}) {
  const { threadStream, setThreadPane, loadThread, onThreadMessage } = thread;
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
          <h1>Thread</h1>
          <p>replies on this message</p>
        </div>
        <div className="thread-tools">
          {threadPane.task ? <span className="st">{threadPane.task.state.replaceAll('_', ' ')}</span> : <select
            aria-label="Thread status"
            value={threadPane.threads.find((t) => t.id === threadId)?.status ?? "open"}
            onChange={(e) => thread.setStatus(channelId, threadId, e.target.value as ThreadStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>}
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
        {threadPane.task && <TaskCard task={threadPane.task} decisions={threadPane.decisions} />}
        {threadPane.decision && <DecisionCard decision={threadPane.decision}
          onAnswered={() => {
            onDecisionAnswered();
            loadThread(threadPane.decision!.channelId, threadPane.decision!.id).catch(() => undefined);
          }} />}
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
