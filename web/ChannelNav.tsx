import { useEffect, useRef } from "react";
import type { Channel } from "../src/shared/types.ts";
import { focusFirstMenuItem, menuKeyDown } from "./menu-keys.ts";

export function ChannelItem({
  ch,
  unread,
  active,
  onClick,
  onUnread,
}: {
  ch: Channel;
  unread: number;
  active: boolean;
  onClick: () => void;
  onUnread: () => void;
}) {
  return (
    <div className={`nav ${active ? "active" : ""} ${unread ? "unread" : ""}`}>
      <button type="button" className="nav-open" onClick={onClick} aria-current={active ? "page" : undefined}>
        <span>{ch.type === "dm" ? ch.name : `# ${ch.name}`}</span>
      </button>
      {unread > 0 && <button type="button" className="unread-jump" onClick={onUnread}
        title="Jump to last unread message"
        aria-label={`Jump to last unread message in ${ch.name} (${unread} unread)`}>
        <em>{unread}</em>
      </button>}
    </div>
  );
}

export function DmRow({
  ch,
  unread,
  active,
  menuOpen,
  onClick,
  onMenu,
  onClose,
  onUnread,
}: {
  ch: Channel;
  unread: number;
  active: boolean;
  menuOpen: boolean;
  onClick: () => void;
  onMenu: () => void;
  onClose: () => void;
  onUnread: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (menuOpen) focusFirstMenuItem(menu.current);
  }, [menuOpen]);
  return (
    <div className={`dm-row ${ch.memberIds.includes("human") ? "with-human" : "between-agents"}`}>
      <ChannelItem ch={ch} unread={unread} active={active} onClick={onClick} onUnread={onUnread} />
      <button
        type="button"
        className={`kebab ${menuOpen ? "on" : ""}`}
        ref={trigger}
        title="Conversation actions"
        aria-label={`Conversation actions for ${ch.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onMenu}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="person-menu" role="menu" aria-label={`Conversation actions for ${ch.name}`} ref={menu}
          onKeyDown={(event) => menuKeyDown(event, trigger, onMenu)}>
          <button type="button" role="menuitem" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
