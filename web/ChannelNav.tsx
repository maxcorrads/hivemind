import type { Channel } from "../src/shared/types.ts";

export function ChannelItem({
  ch,
  unread,
  active,
  onClick,
}: {
  ch: Channel;
  unread: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav ${active ? "active" : ""} ${unread ? "unread" : ""}`} onClick={onClick}>
      <span>{ch.type === "dm" ? ch.name : `# ${ch.name}`}</span>
      {unread > 0 && <em>{unread}</em>}
    </button>
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
}: {
  ch: Channel;
  unread: number;
  active: boolean;
  menuOpen: boolean;
  onClick: () => void;
  onMenu: () => void;
  onClose: () => void;
}) {
  return (
    <div className={`dm-row ${ch.memberIds.includes("human") ? "with-human" : "between-agents"}`}>
      <ChannelItem ch={ch} unread={unread} active={active} onClick={onClick} />
      <button
        type="button"
        className={`kebab ${menuOpen ? "on" : ""}`}
        title="Conversation actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onMenu}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="person-menu" role="menu">
          <button type="button" role="menuitem" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
