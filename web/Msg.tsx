import type { Message, ThreadStatus } from "../src/shared/types.ts";
import { REACTION_EMOJIS } from "../src/shared/types.ts";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { BotOrigin } from "./Bots.tsx";
import { renderBody } from "./markdown.tsx";

export function Msg({
  m,
  replies,
  status,
  onThread,
  onReact,
}: {
  m: Message;
  replies: number;
  status: ThreadStatus | null;
  onThread?: (button: HTMLButtonElement) => void;
  onReact?: (emoji: string) => void;
}) {
  const time = new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const placed = (m.reactions ?? []).filter((r) => r.count > 0);
  return (
    <article className={`msg role-${m.authorRole} kind-${m.kind}`}>
      <Avatar name={m.authorName} role={m.authorRole} />
      <div>
        <div className="msg-h">
          <strong>{m.authorName}</strong>
          <span className="role">{m.authorRole}</span>
          <time>{time}</time>
          {m.taskEvent && <span className="st">Task {m.taskEvent.action.type} · v{m.taskEvent.revision}</span>}
          {status && <span className={`st st-${status}`}>{status.replace("_", " ")}</span>}
        </div>
        {m.body && <div className="msg-b">{renderBody(m.body)}</div>}
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
                disabled={!onReact}
                onClick={() => onReact?.(hit.emoji)}
              >
                {hit.emoji}
                <em>{hit.count}</em>
              </button>
            ))}
          </div>
        )}
        {onThread && m.kind === "chat" && (
          <button type="button" className="replies" onClick={event => onThread(event.currentTarget)}>
            {replies > 0 ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "Thread"}
          </button>
        )}
        {m.kind === "chat" && onReact && (
          <div className="react-pick" role="toolbar" aria-label="Add reaction">
            {REACTION_EMOJIS.map((emoji) => {
              const hit = m.reactions?.find((r) => r.emoji === emoji);
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`react-pick-btn ${hit?.mine ? "mine" : ""}`}
                  title={emoji}
                  onClick={() => onReact(emoji)}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}
