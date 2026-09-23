import type { SearchHit } from "../src/shared/types.ts";
import { Avatar } from "./Avatar.tsx";
import { BotOrigin } from "./Bots.tsx";
import { renderSearchBody } from "./search-highlight.tsx";

function SearchHitMsg({ hit, q }: { hit: SearchHit; q: string }) {
  const time = new Date(hit.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <article className={`msg role-${hit.authorRole} kind-${hit.kind}`}>
      <Avatar name={hit.authorName} role={hit.authorRole} />
      <div>
        <div className="msg-h">
          <strong>{hit.authorName}</strong>
          <span className="role">{hit.authorRole}</span>
          <time dateTime={new Date(hit.createdAt).toISOString()}>{time}</time>
          <span className="seq">#{hit.seq}</span>
        </div>
        {hit.body ? <div className="msg-b">{renderSearchBody(hit.body, q)}</div> : null}
        {hit.attachments.length > 0 && (
          <div className="atts">
            {hit.attachments.map((name) => (
              <span key={name} className="att-chip">
                {name}
              </span>
            ))}
          </div>
        )}
        {hit.reactions.length > 0 && (
          <div className="reacts">
            {hit.reactions.map((emoji) => (
              <span key={emoji} className="react">
                {emoji}
              </span>
            ))}
          </div>
        )}
        {!hit.body && hit.attachments.length === 0 && <div className="msg-b muted">(empty)</div>}
      </div>
    </article>
  );
}

export function SearchDesk({
  hiveName,
  q,
  hits,
  hasMore,
  busy,
  onOpen,
  onOlder,
  onClear,
}: {
  hiveName: string;
  q: string;
  hits: SearchHit[];
  hasMore: boolean;
  busy: boolean;
  onOpen: (hit: SearchHit) => void;
  onOlder: () => void;
  onClear: () => void;
}) {
  return (
    <>
      <header className="desk-h">
        <div>
          <h1>Search</h1>
          <p>
            {hiveName}
            {q ? ` · “${q}”` : ""}
          </p>
        </div>
        <button type="button" className="text-btn" onClick={onClear}>
          Clear
        </button>
      </header>
      <div className="stream">
        {hits.length === 0 && !busy && <div className="empty">No messages match in this hive.</div>}
        {busy && hits.length === 0 && <div className="empty">Searching…</div>}
        {hits.map((hit) => {
          const where = hit.channelType === "dm" ? hit.channelName : `#${hit.channelName}`;
          return (
            <div key={hit.seq} className="inbox-item">
              <button type="button" className="search-hit-open" onClick={() => onOpen(hit)}>
                <SearchHitMsg hit={hit} q={q} />
                <span className="open-link">
                  {where}
                  {hit.threadId ? " · open thread" : " · open conversation"}
                </span>
              </button>
              <BotOrigin event={hit.botEvent} />
            </div>
          );
        })}
        {hasMore && (
          <button type="button" className="older" onClick={onOlder}>
            Older matches
          </button>
        )}
      </div>
    </>
  );
}
