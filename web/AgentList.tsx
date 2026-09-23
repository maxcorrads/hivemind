import { useEffect, useRef, useState } from "react";
import type { Agent, InboxStatus } from "../src/shared/types.ts";
import { Avatar } from "./Avatar.tsx";
import { InboxReceipt, QueueBadge } from "./InboxReceipt.tsx";
import { seniorityBars } from "./labels.ts";

export function AgentList({
  agents,
  projectName,
  onCreateBot,
  onManageBot,
  onLaunch,
  queued,
  inbox = {},
  onOpen,
  onAskClear,
  onAskRemove,
}: {
  agents: Agent[];
  projectName: string;
  onCreateBot: () => void;
  onManageBot?: (a: Agent) => void;
  /** Opens the Launch sheet for this project; shown as the call to action when no brain or worker has joined. */
  onLaunch?: () => void;
  queued: Record<string, number>;
  inbox?: Record<string, InboxStatus>;
  onOpen: (a: Agent) => void;
  onAskClear: (name: string) => void;
  onAskRemove: (name: string) => void;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const human = agents.find((a) => a.role === "human");
  const brains = agents.filter((a) => a.role === "brain");
  const workers = agents.filter((a) => a.role === "worker");
  const bots = agents.filter((a) => a.role === "bot");
  const rank = { senior: 0, mid: 1, junior: 2 } as const;
  workers.sort((a, b) => (rank[a.seniority ?? "mid"] ?? 3) - (rank[b.seniority ?? "mid"] ?? 3) || a.name.localeCompare(b.name));

  return (
    <div className="agents">
      {human && <PersonRow agent={human} onOpen={() => undefined} self />}
      {brains.length + workers.length === 0 && (
        <div className="roster-empty">
          <p>No brains or workers in {projectName} yet. Launch one to start working here.</p>
          {onLaunch && <button type="button" className="launch-cta" onClick={onLaunch}>Launch an agent</button>}
        </div>
      )}
      {brains.length > 0 && <div className="subh">brain</div>}
      {brains.map((a) => (
        <PersonRow
          key={a.id}
          agent={a}
          queued={queued[a.id] ?? 0}
          inbox={inbox[a.id]}
          onOpen={() => onOpen(a)}
          menuOpen={menu === a.name}
          onMenu={() => setMenu(menu === a.name ? null : a.name)}
          onCloseMenu={() => setMenu(null)}
          onAskRemove={() => {
            setMenu(null);
            onAskRemove(a.name);
          }}
        />
      ))}
      {workers.length > 0 && <div className="subh">worker</div>}
      {workers.map((a) => (
        <PersonRow
          key={a.id}
          agent={a}
          queued={queued[a.id] ?? 0}
          inbox={inbox[a.id]}
          onOpen={() => onOpen(a)}
          menuOpen={menu === a.name}
          onMenu={() => setMenu(menu === a.name ? null : a.name)}
          onCloseMenu={() => setMenu(null)}
          onAskClear={() => {
            setMenu(null);
            onAskClear(a.name);
          }}
          onAskRemove={() => {
            setMenu(null);
            onAskRemove(a.name);
          }}
        />
      ))}
      <div className="subh bot-h">
        <span>bot · context only</span>
        <button type="button" className="plus" title={`Create bot in ${projectName}`}
          aria-label={`Create bot in ${projectName}`} onClick={onCreateBot}>+</button>
      </div>
      {bots.map((a) => (
        <PersonRow key={a.id} agent={a} onOpen={() => undefined} self
          onManageCredential={onManageBot ? () => onManageBot(a) : undefined}
          menuOpen={menu === a.name}
          onMenu={onManageBot ? () => setMenu(menu === a.name ? null : a.name) : undefined}
          onCloseMenu={() => setMenu(null)} />
      ))}
    </div>
  );
}

function PersonRow({
  onManageCredential,
  agent,
  queued,
  inbox,
  onOpen,
  self,
  menuOpen,
  onMenu,
  onCloseMenu,
  onAskClear,
  onAskRemove,
}: {
  onManageCredential?: () => void;
  agent: Agent;
  queued?: number;
  inbox?: InboxStatus;
  onOpen: () => void;
  self?: boolean;
  menuOpen?: boolean;
  onMenu?: () => void;
  onCloseMenu?: () => void;
  onAskClear?: () => void;
  onAskRemove?: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const bars = seniorityBars(agent);

  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (menuRef.current?.contains(e.target)) return;
      onCloseMenu?.();
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [menuOpen, onCloseMenu]);

  return (
    <div className={`person ${agent.online ? "on" : "off"}`} ref={menuRef}>
      <button type="button" className="person-main" onClick={onOpen} disabled={self}>
        <Avatar name={agent.name} role={agent.role} online={agent.online} small />
        <span className="person-details">
          <span className="person-label">
            <span className="pn" title={agent.name}>{agent.name}</span>
            <QueueBadge count={queued} estimate={inbox?.queued} />
          </span>
          {(agent.seniority || agent.focus) && (
            <span className="person-meta">
              {agent.seniority && <span className="person-rank">
                {bars > 0 && <span className="stripes" aria-hidden="true">
                  {Array.from({ length: bars }, (_, i) => <i key={i} />)}
                </span>}
                <span className="sen">{agent.seniority}</span>
              </span>}
              {agent.focus && <span className="focus" title={agent.focus}>{agent.focus}</span>}
            </span>
          )}
          <InboxReceipt status={inbox} />
        </span>
      </button>
      {onMenu && (
        <button
          type="button"
          className={`kebab ${menuOpen ? "on" : ""}`}
          ref={actionRef}
          title={`Actions for ${agent.name}`}
          aria-label={`Actions for ${agent.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={onMenu}
        >
          ⋯
        </button>
      )}
      {menuOpen && (
        <div className="person-menu" role="menu" aria-label={`Actions for ${agent.name}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCloseMenu?.();
              actionRef.current?.focus();
            } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            } else if (event.key === "Tab") {
              actionRef.current?.focus();
              onCloseMenu?.();
            }
          }}>
          {onManageCredential && (
            <button type="button" role="menuitem" aria-label={`Manage credentials for ${agent.name}`}
              onClick={() => { onCloseMenu?.(); onManageCredential(); }}>
              Credentials
            </button>
          )}
          {onAskClear && (
            <button type="button" role="menuitem" onClick={onAskClear}>
              Clear context
            </button>
          )}
          {onAskRemove && (
            <button type="button" role="menuitem" className="bad" onClick={onAskRemove}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
