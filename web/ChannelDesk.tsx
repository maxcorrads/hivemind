import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import type { AdaptiveRoutingView } from "../src/shared/adaptive-topology.ts";
import type { Agent, Channel, Message, ThreadStatus } from "../src/shared/types.ts";
import { adviceSummary } from "./AdaptiveRoutingPanel.tsx";
import { adviceStrip } from "./adaptive-routing-view.ts";
import { api } from "./api.ts";
import { applyChannelMessage, recordChannelMessage } from "./channel-state.ts";
import { Composer } from "./Composer.tsx";
import { channelTitle, memberNames } from "./labels.ts";
import { BackButton } from "./MobileNav.tsx";
import { MessageRow } from "./MessageRow.tsx";
import { streamRows } from "./message-stream.ts";
import { StreamDivider } from "./StreamCards.tsx";
import { holdLivePane, isReadingHistory } from "./pane-window.ts";
import { RoomPanel } from './RoomPanel.tsx';
import type { Sel } from "./selection.ts";
import type { ChannelPane } from "./use-channel-pane.ts";
import type { useSend } from "./use-send.ts";
import type { ThreadOpenAnchor } from "./use-thread-scroll-anchor.ts";

const NO_MESSAGES: Message[] = [];

/** The selected channel: header, room panel, message stream, Jev advice strip and composer. */
export function ChannelDesk({ channelId, activeChannel, agents, roomAgents, channel, threadPaneId, stickBottom, threadOpenAnchor,
  go, roomTick, routingView, activeBrainChannel, brainNames, onOpenRouting, onInvite, compose, onMarkUnread, setErr, onBack }: {
  channelId: string;
  activeChannel: Channel | undefined;
  agents: Agent[];
  roomAgents: Agent[];
  channel: ChannelPane;
  threadPaneId: string | null | undefined;
  stickBottom: MutableRefObject<boolean>;
  threadOpenAnchor: MutableRefObject<ThreadOpenAnchor | null>;
  go: (next: Sel) => void;
  roomTick: number;
  routingView: AdaptiveRoutingView | null;
  activeBrainChannel: boolean;
  brainNames: Record<string, string>;
  onOpenRouting: () => void;
  onInvite: () => void;
  compose: ReturnType<typeof useSend>;
  /** Marks root messages from `seq` on unread for the Human and refreshes the read state. */
  onMarkUnread: (channelId: string, seq: number) => Promise<void>;
  setErr: (error: string) => void;
  /** Phones only: leaves the full-screen channel for the list it was opened from. */
  onBack: () => void;
}) {
  const { pane, setPane, channelStream, channelJournal, loadChannel } = channel;
  const loaded = pane?.channel.id === channelId;
  const statuses = useMemo(() => new Map<string, ThreadStatus | null>((pane?.threads ?? []).map((t) => [t.id, t.status])), [pane?.threads]);
  const firstUnreadSeq = loaded ? pane.firstUnreadSeq ?? null : null;
  const messages = loaded ? pane.messages : NO_MESSAGES;
  const rows = useMemo(() => streamRows(messages, { firstUnreadSeq }), [messages, firstUnreadSeq]);
  const agentNames = useMemo(() => Object.fromEntries(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const markUnreadRef = useRef(onMarkUnread);
  markUnreadRef.current = onMarkUnread;
  // Stable across renders so memoized rows keep their props: the divider moves here at once, the server follows.
  const markUnread = useCallback((m: Message) => {
    setPane((current) => current?.channel.id === m.channelId ? { ...current, firstUnreadSeq: m.seq } : current);
    markUnreadRef.current(m.channelId, m.seq).catch((error) => setErr(String(error)));
  }, [setPane, setErr]);
  const onThread = useCallback((m: Message, button: HTMLElement) => {
    const stream = channelStream.current;
    if (stream && threadPaneId !== m.id) {
      threadOpenAnchor.current = {
        channelId, threadId: m.id, button, bottom: button.getBoundingClientRect().bottom,
        atBottom: stream.scrollHeight - stream.clientHeight - stream.scrollTop <= 48,
      };
    }
    go({ kind: "channel", id: channelId, thread: m.id });
  }, [channelStream, threadOpenAnchor, threadPaneId, channelId, go]);
  const onReact = useCallback((m: Message, emoji: string) => {
    api.react(m.seq, emoji, !m.reactions?.some(reaction => reaction.emoji === emoji && reaction.mine)).then((r) => {
      recordChannelMessage(channelJournal.current, r.message, false);
      setPane((p) => applyChannelMessage(p, r.message, false));
    }).catch((error) => setErr(String(error)));
  }, [channelJournal, setPane, setErr]);
  const sendChannel = compose.sendChannel;
  return (
    <>
      <header className="desk-h">
        <BackButton label="Back" onBack={onBack} />
        <div>
          <h1>{activeChannel ? channelTitle(activeChannel) : channelId}</h1>
          {activeChannel?.topic && <p>{activeChannel.topic}</p>}
          {activeChannel && (
            <p className="members">
              {memberNames(activeChannel, agents)}
            </p>
          )}
        </div>
        {(activeChannel?.type === "private" || activeChannel?.type === "public") && (
          <button type="button" className="text-btn" onClick={onInvite}>
            Invite
          </button>
        )}
      </header>
      <div className="stream" role="log" aria-label="Messages" ref={channelStream} onScroll={() => {
        if (isReadingHistory(channelStream.current)) setPane((current) => current ? holdLivePane(current) : current);
      }}>
        {activeChannel && ['private', 'public'].includes(activeChannel.type) && <RoomPanel key={activeChannel.id} channel={activeChannel} agents={agents} tick={roomTick} />}
        {pane?.hasOlder && (
          <button
            type="button"
            className="older"
            onClick={() => {
              const oldest = pane.messages[0]?.seq;
              if (!oldest) return;
              stickBottom.current = false;
              setPane((current) => current ? holdLivePane(current) : current);
              loadChannel(channelId, oldest).catch((error) => {
                if (error?.name !== "AbortError") setErr(String(error));
              });
            }}
          >
            Load older
          </button>
        )}
        {!loaded && <div className="loading" role="status">Loading messages…</div>}
        {loaded && pane.messages.length === 0 && !pane.hasOlder && <div className="empty">No messages yet.</div>}
        {rows.map((row) => row.type === "date" ? <StreamDivider key={row.key} label={row.label} />
          : row.type === "new" ? <StreamDivider key={row.key} label="New messages" unread /> : (
          <MessageRow
            key={row.key}
            m={row.message}
            grouped={row.grouped}
            replies={pane?.replyCounts[row.message.id] ?? 0}
            status={statuses.get(row.message.id) ?? null}
            taskRoute={row.message.taskEvent &&
              `${agentNames[row.message.taskEvent.assignerId] ?? "Brain"} → ${agentNames[row.message.taskEvent.workerId] ?? "worker"}`}
            onThread={onThread}
            onReact={onReact}
            onMarkUnread={markUnread}
          />
        ))}
        <div />
      </div>
      {pane?.channel.id === channelId && pane.historyThrough !== undefined && (
        <div className="jump-dock">
          <button type="button" className="jump-pill" onClick={() => {
            loadChannel(channelId, undefined, []).catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
          }}>
            {pane.deferredLive ? "New messages — jump to recent" : "Jump to recent"}
          </button>
        </div>
      )}
      {activeBrainChannel && routingView && (
        <RoutingStrip view={routingView} channelId={activeChannel?.id} brainNames={brainNames} onOpen={onOpenRouting} />
      )}
      <Composer
        agents={roomAgents}
        placeholder={
          activeChannel
            ? `Message ${channelTitle(activeChannel)}`
            : "Write…"
        }
        onSend={sendChannel}
      />
    </>
  );
}

/**
 * Informational strip above the composer (#211): Jev's latest advice for the primary request in this channel, e.g.
 * "Jev suggests: Multi-DM · 2 workers (72%)". Nothing is applied; it opens the Routing panel. Jev is optional (#214):
 * the strip is absent while Jev is disabled, before it has advised, and when its call failed (the Routing log has it).
 */
export function RoutingStrip({ view, channelId, brainNames, onOpen }: {
  view: AdaptiveRoutingView;
  channelId: string | undefined;
  brainNames: Record<string, string>;
  onOpen: () => void;
}) {
  const { state, brains } = adviceStrip(view, channelId);
  const failed = state?.advice?.state === "unavailable" || state?.advice?.state === "rejected";
  if (!state?.recommendation || state.monitoring === "disabled" || failed) return null;
  const unsure = state.advice && state.advice.state !== "ok";
  return (
    <div className={`routing-strip ${unsure ? "warning" : ""}`}>
      <button type="button" onClick={onOpen}>
        <strong>{adviceSummary(state.recommendation)}</strong>
        {brains > 1 ? ` · ${brainNames[state.brainId] ?? "brain"} · ${brains} brains` : ""}
      </button>
      <span>
        {state.monitoring === "completed" ? "Request closed · no further advice" : "Advisory only · the brain decides"}
      </span>
    </div>
  );
}
