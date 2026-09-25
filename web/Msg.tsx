import { memo, useEffect, useRef, useState } from "react";
import type { Message, ThreadStatus } from "../src/shared/types.ts";
import { EXTRA_REACTION_EMOJIS, REACTION_EMOJIS } from "../src/shared/types.ts";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { BotOrigin } from "./Bots.tsx";
import { Markdown } from "./markdown.tsx";
import { formatTime, isDecisionRequest } from "./message-stream.ts";
import { hashFor } from "./selection.ts";
import { DecisionRequestCard, TaskEventCard } from "./StreamCards.tsx";

const LONG_PRESS_MS = 450;

/** A link that reopens the message: its thread (or the thread it starts) in its channel. */
export function messageLink(m: Pick<Message, "id" | "channelId" | "threadId">): string {
  return `${location.origin}${location.pathname}#${hashFor({ kind: "channel", id: m.channelId, thread: m.threadId ?? m.id })}`;
}

/**
 * One message row. `grouped` hides the header of a follow-up from the same author (time on hover);
 * system messages render as a centered line, task events and decision requests as compact cards.
 * Memoized: a row re-renders only when its message, counts or (stable) handlers change, so keep props
 * primitive or stable (see MessageRow).
 */
export const Msg = memo(function Msg({
  m,
  replies,
  status,
  grouped = false,
  taskRoute,
  onThread,
  onReact,
  onMarkUnread,
}: {
  m: Message;
  replies: number;
  status: ThreadStatus | null;
  grouped?: boolean;
  /** "Assigner → Worker" for a task event, resolved by the caller. */
  taskRoute?: string;
  onThread?: (anchor: HTMLElement) => void;
  onReact?: (emoji: string) => void;
  onMarkUnread?: (m: Message) => void;
}) {
  const row = useRef<HTMLElement>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const [copied, setCopied] = useState(false);
  const press = useRef<number | null>(null);
  const time = formatTime(m.createdAt);
  const stamp = new Date(m.createdAt);

  // Touch has no hover: a long press opens the toolbar until the next touch elsewhere.
  useEffect(() => {
    if (!toolsOpen) return;
    const close = (event: PointerEvent) => {
      if (!row.current?.contains(event.target as Node)) { setToolsOpen(false); setPicker(false); }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [toolsOpen]);
  useEffect(() => () => { if (press.current !== null) window.clearTimeout(press.current); }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (m.kind === "system") {
    return (
      <article className="msg sys kind-system" tabIndex={-1} data-message-seq={m.seq}>
        <p>
          <span>{m.body}</span>
          <time dateTime={stamp.toISOString()} title={stamp.toLocaleString()}>{time}</time>
        </p>
      </article>
    );
  }

  const placed = (m.reactions ?? []).filter((r) => r.count > 0);
  const open = onThread ? () => row.current && onThread(row.current) : undefined;
  const done = () => { setToolsOpen(false); setPicker(false); };
  const cancelPress = () => { if (press.current !== null) { window.clearTimeout(press.current); press.current = null; } };
  const tools = m.kind === "chat" && onReact;
  const showHeader = !grouped || status !== null;
  const reactButton = (emoji: string, className: string) => {
    const hit = m.reactions?.find((r) => r.emoji === emoji);
    return (
      <button key={emoji} type="button" className={`${className} ${hit?.mine ? "mine" : ""}`} title={emoji}
        aria-pressed={Boolean(hit?.mine)} aria-label={`React ${emoji}`}
        onClick={() => { done(); onReact?.(emoji); }}>
        {emoji}
      </button>
    );
  };
  return (
    <article
      ref={row}
      data-message-seq={m.seq}
      className={`msg role-${m.authorRole} kind-${m.kind} ${grouped ? "grouped" : ""} ${toolsOpen ? "tools-open" : ""}`}
      // Focusable so a tap on touch screens reveals the toolbar (:focus-within), as hover does with a mouse.
      tabIndex={-1}
      onPointerDown={tools ? (event) => {
        if (event.pointerType !== "touch") return;
        cancelPress();
        press.current = window.setTimeout(() => { press.current = null; setToolsOpen(true); }, LONG_PRESS_MS);
      } : undefined}
      onPointerUp={tools ? cancelPress : undefined}
      onPointerCancel={tools ? cancelPress : undefined}
      onContextMenu={tools ? (event) => { if (toolsOpen) event.preventDefault(); } : undefined}
    >
      {showHeader ? <Avatar name={m.authorName} role={m.authorRole} /> : (
        <time className="gutter-time" dateTime={stamp.toISOString()} title={stamp.toLocaleString()}>{time}</time>
      )}
      <div>
        {showHeader && (
          <div className="msg-h">
            <strong>{m.authorName}</strong>
            <span className="role">{m.authorRole}</span>
            <time dateTime={stamp.toISOString()} title={stamp.toLocaleString()}>{time}</time>
            {status && <span className={`st st-${status}`}>{status.replace("_", " ")}</span>}
          </div>
        )}
        {m.taskEvent ? <TaskEventCard envelope={m.taskEvent} route={taskRoute} body={m.body} onOpen={open} />
          : isDecisionRequest(m) ? <DecisionRequestCard body={m.body} onOpen={open} />
          : m.body && <Markdown body={m.body} />}
        <BotOrigin event={m.botEvent} />
        {(m.attachments?.length ?? 0) > 0 && (
          <div className="atts">
            {m.attachments!.map((a) =>
              a.mime.startsWith("image/") ? (
                <a key={a.id} href={api.fileUrl(a.id)} target="_blank" rel="noreferrer">
                  <img className="att-img" src={api.fileUrl(a.id)} alt={a.name} />
                </a>
              ) : (
                <a key={a.id} className="att-chip" href={api.fileUrl(a.id)} target="_blank" rel="noreferrer">
                  {a.name}
                  <small>{Math.max(1, Math.round(a.bytes / 1024))} KB</small>
                </a>
              ),
            )}
          </div>
        )}
        {m.kind === "chat" && placed.length > 0 && (
          <div className="reacts">
            {placed.map((hit) => (
              <button
                key={hit.emoji}
                type="button"
                className={`react ${hit.mine ? "mine" : ""}`}
                aria-pressed={Boolean(hit.mine)}
                disabled={!onReact}
                onClick={() => onReact?.(hit.emoji)}
              >
                {hit.emoji}
                <em>{hit.count}</em>
              </button>
            ))}
          </div>
        )}
        {onThread && m.kind === "chat" && replies > 0 && (
          <button type="button" className="replies" onClick={(event) => onThread(event.currentTarget)}>
            {`${replies} ${replies === 1 ? "reply" : "replies"}`}
          </button>
        )}
        {tools && (
          <div className="msg-tools" role="toolbar" aria-label="Message actions">
            <div className="react-pick" role="group" aria-label="Add reaction">
              {REACTION_EMOJIS.map((emoji) => reactButton(emoji, "react-pick-btn"))}
            </div>
            <button type="button" className="tool-btn" aria-label="More reactions" title="More reactions" aria-expanded={picker}
              onClick={() => setPicker((value) => !value)}>☺</button>
            {onThread && (
              <button type="button" className="tool-btn" aria-label="Reply in thread" title="Reply in thread"
                onClick={() => { done(); open?.(); }}>💬</button>
            )}
            <button type="button" className="tool-btn" aria-label="Copy link" title={copied ? "Copied" : "Copy link"}
              onClick={() => {
                done();
                void navigator.clipboard?.writeText(messageLink(m)).then(() => setCopied(true), () => undefined);
              }}>{copied ? "✓" : "🔗"}</button>
            {onMarkUnread && (
              <button type="button" className="tool-btn" aria-label="Mark unread" title="Mark unread from here"
                onClick={() => { done(); onMarkUnread(m); }}>●</button>
            )}
            {picker && (
              <div className="emoji-picker" role="group" aria-label="More reactions">
                {EXTRA_REACTION_EMOJIS.map((emoji) => reactButton(emoji, "react-pick-btn"))}
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
});
