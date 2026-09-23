import { useState } from "react";
import type { Agent, Channel, Message } from "../src/shared/types.ts";
import { Msg } from "./Msg.tsx";
import type { InboxBox } from "./selection.ts";

export function Inbox({ box, mentions, hasMore, channels, agents, onBox, onOpen, onOlder, onMarkSeen, onMarkMessage, onDecisions }: {
  box: InboxBox;
  mentions: Message[];
  hasMore: boolean;
  channels: Channel[];
  agents: Agent[];
  onBox: (box: InboxBox) => void;
  onOpen: (message: Message) => void;
  onOlder: () => void;
  onMarkSeen: () => void;
  onMarkMessage: (message: Message) => Promise<void>;
  onDecisions: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "direct" | "mentions">("all");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [marking, setMarking] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const direct = (m: Message) => channels.some(ch => ch.id === m.channelId && ch.type === "dm" && ch.memberIds.includes("human"));
  const visible = mentions.filter(m => filter === "all" || (filter === "direct" ? direct(m) : !direct(m)));
  return <>
    <header className="desk-h inbox-header">
      <div>
        <h1>For you</h1>
        <p>{box === "all" ? "Activity saved in this browser. Older read messages may not be included." : "Unread messages addressed to you, including mentions in other conversations."}</p>
        <div className="inbox-tabs" aria-label="Read status">
          <button type="button" className={box === "unread" ? "on" : ""} aria-pressed={box === "unread"} onClick={() => onBox("unread")}>Unread</button>
          <button type="button" className={box === "all" ? "on" : ""} aria-pressed={box === "all"} onClick={() => onBox("all")}>All</button>
          <button type="button" onClick={onDecisions}>Decisions →</button>
        </div>
        <div className="inbox-tabs inbox-filters" aria-label="Activity type">
          {([["all", "All activity"], ["direct", "Direct messages"], ["mentions", "Mentions elsewhere"]] as const).map(([value, label]) =>
            <button key={value} type="button" className={filter === value ? "on" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
      </div>
      {box === "unread" && mentions.length > 0 && <button type="button" className="text-btn" onClick={onMarkSeen}>Mark all read</button>}
    </header>
    <div className="stream inbox-stream">
      {error && <p className="inbox-error" role="alert">{error}</p>}
      {visible.length === 0 && <div className="empty">{mentions.length ? "No messages in this category on this page." : box === "all" ? "No activity saved in this browser yet." : "You're all caught up."}</div>}
      {visible.map(m => {
        const ch = channels.find(c => c.id === m.channelId);
        const isExpanded = expanded.includes(m.id);
        return <article key={m.id} className={`inbox-item inbox-card ${isExpanded ? "expanded" : "collapsed"}`}>
          <div className="inbox-context">
            <span>{direct(m) ? "Direct message" : "Mention"}</span>
            <strong>{ch ? (ch.type === "dm" ? ch.name : `#${ch.name}`) : "Conversation"}</strong>
            <time dateTime={new Date(m.createdAt).toISOString()}>{new Date(m.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</time>
          </div>
          <Msg m={m} replies={0} status={null} />
          <div className="inbox-actions">
            <button type="button" className="text-btn" onClick={() => onOpen(m)}>{m.threadId ? "Open thread" : "Open conversation"}</button>
            <button type="button" className="text-btn" aria-expanded={isExpanded} onClick={() => setExpanded(ids => isExpanded ? ids.filter(id => id !== m.id) : [...ids, m.id])}>{isExpanded ? "Collapse" : "Expand"}</button>
            {box === "unread" && <button type="button" className="text-btn" disabled={marking.includes(m.id)} onClick={() => {
              setMarking(ids => [...ids, m.id]); setError(null);
              onMarkMessage(m).catch(err => setError(String(err.message || err))).finally(() => setMarking(ids => ids.filter(id => id !== m.id)));
            }}>{marking.includes(m.id) ? "Marking…" : "Mark read"}</button>}
          </div>
        </article>;
      })}
      {hasMore && <button type="button" className="older" onClick={onOlder}>Load older activity</button>}
    </div>
    {agents.filter(a => a.role !== "human").length === 0 && <div className="hint">Launch an agent to start a conversation.</div>}
  </>;
}
