import type { Channel } from "../src/shared/types.ts";
import type { Snapshot } from "./api.ts";
import { ChannelItem } from "./ChannelNav.tsx";
import type { MobileTab } from "./mobile-nav.ts";

const TABS: [MobileTab, string][] = [["home", "Home"], ["dms", "DMs"], ["activity", "Activity"], ["decisions", "Decisions"]];

/** The phone's bottom tab bar (#223). Hidden on wide screens and while a channel or thread is open. */
export function MobileTabs({ active, badges, onTab }: {
  active: MobileTab | null;
  badges: Partial<Record<MobileTab, number>>;
  onTab: (tab: MobileTab) => void;
}) {
  return (
    <nav className="m-tabs" aria-label="Sections">
      {TABS.map(([tab, label]) => (
        <button key={tab} type="button" className={active === tab ? "on" : ""} aria-current={active === tab ? "page" : undefined}
          onClick={() => onTab(tab)}>
          <span>{label}</span>
          {(badges[tab] ?? 0) > 0 && <em>{badges[tab]}</em>}
        </button>
      ))}
    </nav>
  );
}

/** A back arrow for full-screen channel and thread headers on phones. */
export function BackButton({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button type="button" className="m-back" aria-label={label} title={label} onClick={onBack}>
      <span aria-hidden="true">←</span>
    </button>
  );
}

/** Direct messages the Human is in come first, unread before read. */
export function projectDms(snap: Snapshot, project: string): { withYou: Channel[]; between: Channel[] } {
  const dms = snap.channels.filter(ch => ch.project === project && ch.type === "dm").sort((a, b) =>
    (snap.unread[b.id] ?? 0) - (snap.unread[a.id] ?? 0) || a.name.localeCompare(b.name));
  return { withYou: dms.filter(ch => ch.memberIds.includes("human")), between: dms.filter(ch => !ch.memberIds.includes("human")) };
}

/** The DMs tab: every direct conversation of the project, full screen. */
export function MobileDms({ snap, project, onOpen, onUnread }: {
  snap: Snapshot;
  project: string;
  onOpen: (channelId: string) => void;
  onUnread: (channelId: string) => void;
}) {
  const { withYou, between } = projectDms(snap, project);
  const row = (ch: Channel) => (
    <ChannelItem key={ch.id} ch={ch} unread={snap.unread[ch.id] ?? 0} active={false}
      onClick={() => onOpen(ch.id)} onUnread={() => onUnread(ch.id)} />
  );
  return (
    <>
      <header className="desk-h">
        <div>
          <h1>Direct messages</h1>
          <p>{snap.projects.find(p => p.slug === project)?.name ?? project}</p>
        </div>
      </header>
      <div className="stream m-list">
        {withYou.length === 0 && <p className="empty">No conversations yet. Open one from an agent on Home.</p>}
        {withYou.map(row)}
        {between.length > 0 && (
          <details className="agent-conversations">
            <summary>Between agents <span>{between.length}</span></summary>
            {between.map(row)}
          </details>
        )}
      </div>
    </>
  );
}
