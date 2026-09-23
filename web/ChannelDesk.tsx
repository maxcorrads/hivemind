import type { MutableRefObject } from "react";
import type { AdaptiveRoutingView } from "../src/shared/adaptive-topology.ts";
import type { Agent, Channel } from "../src/shared/types.ts";
import { routingEventLabel, topologyLabel } from "./AdaptiveRoutingPanel.tsx";
import { routingStreamEntries } from "./adaptive-routing-view.ts";
import { api } from "./api.ts";
import { applyChannelMessage, recordChannelMessage } from "./channel-state.ts";
import { Composer } from "./Composer.tsx";
import { channelTitle, memberNames } from "./labels.ts";
import { Msg } from "./Msg.tsx";
import { holdLivePane, isReadingHistory } from "./pane-window.ts";
import { RoomPanel } from './RoomPanel.tsx';
import type { Sel } from "./selection.ts";
import type { ChannelPane } from "./use-channel-pane.ts";
import type { useSend } from "./use-send.ts";
import type { ThreadOpenAnchor } from "./use-thread-scroll-anchor.ts";

/** The selected channel: header, room panel, message stream with inline routing events, routing strip and composer. */
export function ChannelDesk({ channelId, activeChannel, agents, roomAgents, channel, threadPaneId, stickBottom, threadOpenAnchor,
  go, roomTick, routingView, activeBrainChannel, activeExecutions, finishingExecutions, brainNames, onOpenRouting, onInvite, compose, setErr }: {
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
  activeExecutions: number;
  /** Superseded executions still draining in this channel. */
  finishingExecutions: number;
  brainNames: Record<string, string>;
  onOpenRouting: () => void;
  onInvite: () => void;
  compose: ReturnType<typeof useSend>;
  setErr: (error: string) => void;
}) {
  const { pane, setPane, channelStream, channelJournal, loadChannel } = channel;
  return (
    <>
      <header className="desk-h">
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
      {pane?.historyThrough !== undefined && (
        <button type="button" className="older" onClick={() => {
          const id = channelId;
          loadChannel(id, undefined, []).catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
        }}>
          {pane.deferredLive ? "New messages — return to live" : "Return to live"}
        </button>
      )}
      <div className="stream" ref={channelStream} onScroll={() => {
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
        {routingStreamEntries(pane?.channel.id === channelId ? pane.messages : [],
          routingView?.events ?? [], channelId).map(entry => entry.kind === "routing" ? (
          <div key={entry.event.id} className="routing-inline" data-human-only="routing">
            {routingEventLabel(entry.event)}
          </div>
        ) : ((m) => (
          <Msg
            key={m.id}
            m={m}
            replies={pane?.replyCounts[m.id] ?? 0}
            status={pane?.threads.find((t) => t.id === m.id)?.status ?? null}
            onThread={(button) => {
              const stream = channelStream.current;
              if (stream && threadPaneId !== m.id) {
                threadOpenAnchor.current = {
                  channelId, threadId: m.id, button, bottom: button.getBoundingClientRect().bottom,
                  atBottom: stream.scrollHeight - stream.clientHeight - stream.scrollTop <= 48,
                };
              }
              go({ kind: "channel", id: channelId, thread: m.id });
            }}
            onReact={(emoji) => api.react(m.seq, emoji, !m.reactions?.some(reaction => reaction.emoji === emoji && reaction.mine)).then((r) => {
              recordChannelMessage(channelJournal.current, r.message, false);
              setPane((p) => applyChannelMessage(p, r.message, false));
            })}
          />
        ))(entry.message))}
        <div />
      </div>
      {activeBrainChannel && routingView && routingView.state && routingView.state.channelId === activeChannel?.id && (
        <div className={`routing-strip ${routingView.state.warning ? "warning" : ""}`}>
          <button type="button" onClick={onOpenRouting}>
            <strong>{topologyLabel(routingView.state.currentTopology)}</strong>
            {routingView.state.workerBudget > 0
              ? ` · ${routingView.state.workerBudget} worker${routingView.state.workerBudget === 1 ? "" : "s"}`
              : ""}
            {routingView.state.lockScope !== "none" ? ` · locked ${routingView.state.lockScope}` : ""}
            {activeExecutions > 1 ? ` · ${brainNames[routingView.state.brainId] ?? "brain"} · ${activeExecutions} brains` : ""}
            {finishingExecutions > 0 ? ` · +${finishingExecutions} finishing` : ""}
          </button>
          <span>
            {routingView.state.monitoring === "completed" ? "Execution completed" : routingView.state.monitoring === "disabled"
              ? "Jev disabled · automatic verification is off" : routingView.state.monitoring === "pending"
              ? "Jev enabled · awaiting next coordination event" : routingView.state.warning
              ? `⚠ ${routingView.state.warning}`
              : (() => {
                  const last = [...routingView.events].reverse().find(event => event.kind === "transition");
                  return last ? routingEventLabel(last) : "Jev continuous routing active";
                })()}
          </span>
        </div>
      )}
      <Composer
        agents={roomAgents}
        value={compose.draft}
        onChange={compose.setDraft}
        placeholder={
          activeChannel
            ? `Message ${channelTitle(activeChannel)}`
            : "Write…"
        }
        routing={activeBrainChannel ? {
          value: compose.routingMode,
          onChange: compose.setRoutingMode,
          lockScope: compose.routingLockScope,
          onLockScopeChange: compose.setRoutingLockScope,
        } : undefined}
        onSend={compose.sendChannel}
      />
    </>
  );
}
