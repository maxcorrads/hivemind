import { useState } from "react";
import type { ActivityItem } from "../src/shared/read-state.ts";
import type { Agent, Channel } from "../src/shared/types.ts";
import { ACTIVITY_FILTERS, REASON_LABELS, type ActivityFilter } from "./activity.ts";
import { Msg } from "./Msg.tsx";
import type { InboxBox } from "./selection.ts";

export function Inbox({ box, items, unread, filter, loading = false, failed = false, hasMore, channels, agents, onBox, onFilter, onOpen,
  onOlder, onMarkSeen, onMarkMessage, onDecisions }: {
  box: InboxBox;
  /** The first page of this view has not arrived yet. */
  loading?: boolean;
  /** The first page of this view could not be loaded (the error banner offers a retry). */
  failed?: boolean;
  items: ActivityItem[];
  /** Unread For you entries in this project: the sidebar badge. */
  unread: number;
  filter: ActivityFilter;
  hasMore: boolean;
  channels: Channel[];
  agents: Agent[];
  onBox: (box: InboxBox) => void;
  onFilter: (filter: ActivityFilter) => void;
  onOpen: (item: ActivityItem) => void;
  onOlder: () => void;
  onMarkSeen: () => void;
  onMarkMessage: (item: ActivityItem) => Promise<void>;
  onDecisions: () => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [marking, setMarking] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  return <>
    <header className="desk-h inbox-header">
      <div>
        <h1>For you</h1>
        <p>{box === "all"
          ? "Direct messages, mentions, replies in your threads, decisions and tasks for you — read and unread, on every device."
          : "Unread direct messages, mentions, replies in your threads, decisions and tasks for you."}</p>
        <div className="inbox-tabs" aria-label="Read status">
          <button type="button" className={box === "unread" ? "on" : ""} aria-pressed={box === "unread"} onClick={() => onBox("unread")}>
            Unread{unread > 0 && <em className="inbox-count">{unread}</em>}
          </button>
          <button type="button" className={box === "all" ? "on" : ""} aria-pressed={box === "all"} onClick={() => onBox("all")}>Activity</button>
          <button type="button" onClick={onDecisions}>Decisions →</button>
        </div>
        <div className="inbox-tabs inbox-filters" aria-label="Activity type">
          {ACTIVITY_FILTERS.map(({ value, label }) =>
            <button key={value} type="button" className={filter === value ? "on" : ""} aria-pressed={filter === value} onClick={() => onFilter(value)}>{label}</button>)}
        </div>
      </div>
      {unread > 0 && <button type="button" className="text-btn" onClick={onMarkSeen}>Mark all read</button>}
    </header>
    <div className="stream inbox-stream">
      {error && <p className="inbox-error" role="alert">{error}</p>}
      {loading ? <div className="loading" role="status">{box === "all" ? "Loading activity…" : "Loading unread messages…"}</div>
        : failed && items.length === 0 ? <div className="empty">{box === "all" ? "Activity could not be loaded." : "Unread messages could not be loaded."}</div>
        : items.length === 0 && <div className="empty">{filter !== "all" ? "Nothing of this type." : box === "all" ? "No activity yet." : "You're all caught up."}</div>}
      {items.map(item => {
        const m = item.message;
        const ch = channels.find(c => c.id === m.channelId);
        const isExpanded = expanded.includes(m.id);
        return <article key={m.id} className={`inbox-item inbox-card ${isExpanded ? "expanded" : "collapsed"} ${item.read ? "read" : "unread"}`}>
          <div className="inbox-context">
            <span>{REASON_LABELS[item.reason]}</span>
            <strong>{ch ? (ch.type === "dm" ? ch.name : `#${ch.name}`) : "Conversation"}</strong>
            {!item.read && box === "all" && <em className="inbox-unread">Unread</em>}
            <time dateTime={new Date(m.createdAt).toISOString()}>{new Date(m.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</time>
          </div>
          <Msg m={m} replies={0} status={null} />
          <div className="inbox-actions">
            <button type="button" className="text-btn" onClick={() => onOpen(item)}>{m.threadId ? "Open thread" : "Open conversation"}</button>
            <button type="button" className="text-btn" aria-expanded={isExpanded} onClick={() => setExpanded(ids => isExpanded ? ids.filter(id => id !== m.id) : [...ids, m.id])}>{isExpanded ? "Collapse" : "Expand"}</button>
            {!item.read && <button type="button" className="text-btn" disabled={marking.includes(m.id)} onClick={() => {
              setMarking(ids => [...ids, m.id]); setError(null);
              onMarkMessage(item).catch(err => setError(String(err.message || err))).finally(() => setMarking(ids => ids.filter(id => id !== m.id)));
            }}>{marking.includes(m.id) ? "Marking…" : "Mark read"}</button>}
          </div>
        </article>;
      })}
      {hasMore && <button type="button" className="older" onClick={onOlder}>Load older activity</button>}
    </div>
    {agents.filter(a => a.role !== "human").length === 0 && <div className="hint">Launch an agent to start a conversation.</div>}
  </>;
}
