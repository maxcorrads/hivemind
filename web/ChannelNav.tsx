import { useEffect, useRef } from "react";
import { Ellipsis, Hash, Lock, MessagesSquare } from "lucide-react";
import type { Agent, Channel } from "../src/shared/types.ts";
import { Avatar } from "./Avatar.tsx";
import { focusFirstMenuItem, menuKeyDown } from "./menu-keys.ts";

/** A channel or DM row. A DM with the Human shows the other agent's avatar and presence (`peer`). */
export function ChannelItem({
  ch,
  unread,
  active,
  peer,
  onClick,
  onUnread,
}: {
  ch: Channel;
  unread: number;
  active: boolean;
  peer?: Agent;
  onClick: () => void;
  onUnread: () => void;
}) {
  const Icon = ch.type === "private" ? Lock : Hash;
  return (
    <div className={`nav ${active ? "active" : ""} ${unread ? "unread" : ""}`}>
      <button type="button" className="nav-open" onClick={onClick} aria-current={active ? "page" : undefined}>
        {ch.type !== "dm"
          ? <Icon className="nav-icon" size={14} aria-hidden="true" />
          : peer
            ? <span className="nav-avatar" aria-hidden="true"><Avatar name={peer.name} role={peer.role} online={peer.online} size="xs" /></span>
            : <MessagesSquare className="nav-icon" size={14} aria-hidden="true" />}
        {/* The icon replaces the visible "#", the name keeps it: "# general" stays what is announced. */}
        <span>{ch.type === "dm" ? ch.name : <><span className="sr-only"># </span>{ch.name}</>}</span>
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
  peer,
  menuOpen,
  onClick,
  onMenu,
  onClose,
  onUnread,
}: {
  ch: Channel;
  unread: number;
  active: boolean;
  peer?: Agent;
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
      <ChannelItem ch={ch} unread={unread} active={active} peer={peer} onClick={onClick} onUnread={onUnread} />
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
        <Ellipsis size={16} aria-hidden="true" />
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
