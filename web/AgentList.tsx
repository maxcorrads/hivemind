import { useEffect, useRef, useState } from "react";
import { Bot, Ellipsis, Plus } from "lucide-react";
import type { AgentWork } from "../src/shared/tasks.ts";
import type { Agent, InboxStatus } from "../src/shared/types.ts";
import { InboxReceipt, QueueBadge } from "./InboxReceipt.tsx";
import { focusFirstMenuItem, menuKeyDown } from "./menu-keys.ts";
import { agentStatusLine } from "./nav-model.ts";

export function AgentList({
  agents,
  projectName,
  onCreateBot,
  onManageBot,
  onLaunch,
  queued,
  inbox = {},
  work = {},
  botChannels = {},
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
  /** Open work per agent id, shown as each brain's and worker's status line. */
  work?: Record<string, AgentWork>;
  /** Where each bot posts, by agent id, e.g. "#general". */
  botChannels?: Record<string, string>;
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
  const row = (a: Agent, canClear: boolean) => (
    <PersonRow
      key={a.id}
      agent={a}
      queued={queued[a.id] ?? 0}
      inbox={inbox[a.id]}
      status={agentStatusLine(a, work[a.id])}
      onOpen={() => onOpen(a)}
      menuOpen={menu === a.name}
      onMenu={() => setMenu(menu === a.name ? null : a.name)}
      onCloseMenu={() => setMenu(null)}
      onAskClear={canClear ? () => {
        setMenu(null);
        onAskClear(a.name);
      } : undefined}
      onAskRemove={() => {
        setMenu(null);
        onAskRemove(a.name);
      }}
    />
  );

  // Brains, then workers by seniority; the role sits beside each name, so the groups need no headings.
  return (
    <div className="agents">
      {human && <PersonRow agent={human} onOpen={() => undefined} self />}
      {brains.length + workers.length === 0 && (
        <div className="roster-empty">
          <p>No brains or workers in {projectName} yet. Launch one to start working here.</p>
          {onLaunch && <button type="button" className="launch-cta" onClick={onLaunch}>Launch an agent</button>}
        </div>
      )}
      {brains.map((a) => row(a, false))}
      {workers.map((a) => row(a, true))}
      <div className="group-h bot-h" title="Integrations that post updates into channels. Bots never take tasks.">
        <span>Bots</span>
        <button type="button" className="plus" title={`Create bot in ${projectName}`}
          aria-label={`Create bot in ${projectName}`} onClick={onCreateBot}><Plus size={14} aria-hidden="true" /></button>
      </div>
      {bots.map((a) => (
        <PersonRow key={a.id} agent={a} onOpen={() => undefined} self status={botChannels[a.id]}
          onManageCredential={onManageBot ? () => onManageBot(a) : undefined}
          menuOpen={menu === a.name}
          onMenu={onManageBot ? () => setMenu(menu === a.name ? null : a.name) : undefined}
          onCloseMenu={() => setMenu(null)} />
      ))}
    </div>
  );
}

/** Beside the name, in mono: "you", "brain", or a worker's seniority. */
function roleLabel(agent: Agent): string | null {
  if (agent.role === "human") return "you";
  if (agent.role === "worker") return agent.seniority ?? "worker";
  return agent.role === "brain" ? "brain" : null;
}

function PersonRow({
  onManageCredential,
  agent,
  queued,
  inbox,
  status,
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
  /** What the agent is doing, e.g. "blocked: API contract". */
  status?: string | null;
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
  const role = roleLabel(agent);
  const queuedCount = inbox?.queued?.atLeast ?? queued ?? 0; // as QueueBadge counts it

  useEffect(() => {
    if (menuOpen) focusFirstMenuItem(menuRef.current);
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
        {agent.role === "bot"
          ? <Bot className="person-icon" size={14} aria-hidden="true" />
          : <i className={`sdot ${agent.online ? "ok" : ""}`} aria-hidden="true" />}
        <span className="person-details">
          <span className="person-label">
            <span className="pn" title={agent.name}>{agent.name}</span>
            {role && <span className="person-role">{role}</span>}
            {status && <span className={`person-status ${status.startsWith("blocked:") ? "blocked" : ""}`} title={status}>{status}</span>}
          </span>
          {(agent.focus || queuedCount > 0) && (
            <span className="person-meta">
              <QueueBadge count={queued} estimate={inbox?.queued} />
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
          <Ellipsis size={16} aria-hidden="true" />
        </button>
      )}
      {menuOpen && (
        <div className="person-menu" role="menu" aria-label={`Actions for ${agent.name}`}
          onKeyDown={(event) => menuKeyDown(event, actionRef, () => onCloseMenu?.())}>
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
