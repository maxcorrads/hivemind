import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { AdaptiveRoutingView } from "../src/shared/adaptive-topology.ts";
import type { ChannelTaskPage } from "../src/shared/tasks.ts";
import type { Agent, Channel, Message, ThreadStatus } from "../src/shared/types.ts";
import { adviceSummary } from "./AdaptiveRoutingPanel.tsx";
import { adviceStrip } from "./adaptive-routing-view.ts";
import { api, type UnreadTarget } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { applyChannelMessage, recordChannelMessage } from "./channel-state.ts";
import { Composer } from "./Composer.tsx";
import { channelTitle, memberNames } from "./labels.ts";
import { BackButton } from "./MobileNav.tsx";
import { MessageRow } from "./MessageRow.tsx";
import { streamRows } from "./message-stream.ts";
import { StreamDivider } from "./StreamCards.tsx";
import { holdLivePane, isReadingHistory } from "./pane-window.ts";
import { Popover } from "./Popover.tsx";
import { RelativeTime } from "./RelativeTime.tsx";
import { RoomPanel } from './RoomPanel.tsx';
import type { Sel } from "./selection.ts";
import { isOpenTask } from "./task-progress.ts";
import { TaskChip } from "./TaskCard.tsx";
import type { ChannelPane } from "./use-channel-pane.ts";
import { useChannelWork } from "./use-channel-work.ts";
import type { useSend } from "./use-send.ts";
import type { ThreadOpenAnchor } from "./use-thread-scroll-anchor.ts";

const NO_MESSAGES: Message[] = [];

export type ChannelTab = "messages" | "tasks" | "contract";

/**
 * The selected channel: header with its members, tabs (Messages · Tasks · Contract for rooms) and, on
 * Messages, the message stream, Jev advice strip and composer.
 */
export function ChannelDesk({ channelId, activeChannel, agents, roomAgents, channel, threadPaneId, stickBottom, threadOpenAnchor, unreadTarget,
  go, roomTick, routingView, activeBrainChannel, brainNames, onOpenRouting, onInvite, compose, onMarkUnread, setErr, onBack }: {
  channelId: string;
  /** A new explicit badge navigation reveals Messages without remounting its draft. */
  unreadTarget?: UnreadTarget | null;
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
  // A tab belongs to the channel it was picked in: another channel opens on Messages.
  const [picked, setPicked] = useState<{ channelId: string; tab: ChannelTab; unreadTarget?: UnreadTarget | null }>({ channelId, tab: "messages" });
  const room = Boolean(activeChannel && ["private", "public"].includes(activeChannel.type));
  const newUnreadJump = unreadTarget?.channelId === channelId && unreadTarget !== picked.unreadTarget;
  const requested = picked.channelId === channelId && !newUnreadJump ? picked.tab : "messages";
  const tab = requested === "contract" && !room ? "messages" : requested;
  const work = useChannelWork(activeChannel, roomTick);
  // The hidden stream loses its scroll position; coming back to a live pane lands on its newest message.
  useLayoutEffect(() => {
    const stream = channelStream.current;
    if (tab === "messages" && stream && pane?.historyThrough === undefined) stream.scrollTop = stream.scrollHeight;
  }, [tab]);
  const openTasks = work.tasks?.items.filter((task) => isOpenTask(task.state)).length ?? 0;
  const tabs: Array<{ id: ChannelTab; label: string; count?: number }> = [
    { id: "messages", label: "Messages" },
    { id: "tasks", label: "Tasks", count: openTasks },
    ...(room ? [{ id: "contract" as const, label: "Contract" }] : []),
  ];
  return (
    <>
      <header className="desk-h channel-h">
        <BackButton label="Back" onBack={onBack} />
        <div>
          <h1>{activeChannel ? channelTitle(activeChannel) : channelId}</h1>
          {activeChannel?.topic && <p>{activeChannel.topic}</p>}
        </div>
        <div className="channel-h-tools">
          {activeChannel && <MemberStack channel={activeChannel} agents={agents} />}
          {room && (
            <button type="button" className="text-btn" onClick={onInvite}>
              Invite
            </button>
          )}
        </div>
      </header>
      <div className="channel-tabs" role="tablist" aria-label="Channel views">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" id={`channel-tab-${item.id}`} aria-selected={tab === item.id}
            aria-controls={tab === item.id ? `channel-panel-${item.id}` : undefined} onClick={() => setPicked({ channelId, tab: item.id, unreadTarget })}>
            {item.label}
            {item.count ? <span className="tab-count">{item.count}</span> : null}
          </button>
        ))}
      </div>
      {tab === "tasks" ? (
        <div className="stream channel-panel" role="tabpanel" id="channel-panel-tasks" aria-labelledby="channel-tab-tasks">
          <TaskList page={work.tasks} error={work.error} activeId={threadPaneId}
            onOpen={(id) => go({ kind: "channel", id: channelId, thread: id })} />
        </div>
      ) : tab === "contract" && activeChannel ? (
        <div className="stream channel-panel" role="tabpanel" id="channel-panel-contract" aria-labelledby="channel-tab-contract">
          <RoomPanel key={activeChannel.id} channel={activeChannel} agents={agents} tick={roomTick} />
        </div>
      ) : null}
      {/* Messages stays mounted while another tab shows, so the composer keeps its draft and the stream its place. */}
      <div className="channel-messages" role="tabpanel" id="channel-panel-messages" aria-labelledby="channel-tab-messages"
        hidden={tab !== "messages"}>
      <div className="stream" role="log" aria-label="Messages" ref={channelStream} onScroll={() => {
        if (isReadingHistory(channelStream.current)) setPane((current) => current ? holdLivePane(current) : current);
      }}>
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
      </div>
    </>
  );
}

/** The first few member avatars and the count; the popover lists everyone with role and presence. */
export function MemberStack({ channel, agents }: { channel: Channel; agents: Agent[] }) {
  const members = channel.memberIds.flatMap((id) => agents.filter((agent) => agent.id === id));
  const label = `${members.length} ${members.length === 1 ? "member" : "members"}: ${memberNames(channel, agents)}`;
  return (
    <Popover className="member-stack" label={label} summary={<>
      <span className="member-avatars" aria-hidden="true">
        {members.slice(0, 4).map((agent) => <Avatar key={agent.id} name={agent.name} role={agent.role} online={agent.online} small />)}
      </span>
      <span className="member-count">{members.length}</span>
    </>}>
      <ul className="member-list" aria-label="Members">
        {members.map((agent) => (
          <li key={agent.id}>
            <Avatar name={agent.name} role={agent.role} online={agent.online} small />
            <span>{agent.name}</span>
            <small>{agent.role}{agent.online ? " · online" : ""}</small>
          </li>
        ))}
        {members.length === 0 && <li>No members</li>}
      </ul>
    </Popover>
  );
}

/** The Tasks tab: every structured task of the channel, most recent activity first; a row opens its thread. */
export function TaskList({ page, error, activeId, onOpen, now }: {
  page: ChannelTaskPage | null;
  error: string | null;
  activeId: string | null | undefined;
  onOpen: (taskId: string) => void;
  now?: number;
}) {
  if (!page) return error ? <p role="alert">{error}</p> : <p className="empty">Loading tasks…</p>;
  if (page.items.length === 0) return <p className="empty">No structured tasks in this channel yet.</p>;
  return (
    <>
      <ul className="task-list">
        {page.items.map((task) => (
          <li key={task.id}>
            <button type="button" aria-current={activeId === task.id ? "true" : undefined} onClick={() => onOpen(task.id)}>
              <TaskChip state={task.state} />
              <strong>{task.objective}</strong>
              <small>{task.assignerName} → {task.workerName} · updated <RelativeTime at={task.updatedAt} now={now} /></small>
            </button>
          </li>
        ))}
      </ul>
      {page.hasMore && <p className="empty">Showing the 100 most recently updated tasks.</p>}
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
