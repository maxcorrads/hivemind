import { ArrowLeft, ChevronDown, Ellipsis, Monitor, Plus, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { Agent, Project } from "../src/shared/types.ts";
import { agentRuntime } from "./agent-runtime.ts";
import { Avatar } from "./Avatar.tsx";
import { focusFirstMenuItem, menuKeyDown } from "./menu-keys.ts";
import { Modal } from "./Modal.tsx";
import { onMacDesktop, type TerminalSessionInfo } from "./native-bridge.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { TerminalNotice } from "./TerminalNotice.tsx";
import { TerminalPanel, type ScreenFactory } from "./TerminalView.tsx";
import { agentTerminalSession, terminalBlocker, terminalHub, useTerminalState, type TerminalState } from "./use-terminal.ts";

/** Who a session belongs to: the agent that reported it on join, else what the launch recorded. */
export function sessionOwner(session: TerminalSessionInfo, agents: Agent[], projects: Project[], terminals?: TerminalState) {
  const agent = agents.find(item => agentTerminalSession(item) === session.name) ??
    (terminals ? agents.find(item => agentRuntime(item, { agents }, terminals).sessionName === session.name) : undefined);
  const slug = agent?.project ?? session.project;
  const project = projects.find(item => item.slug === slug)?.name ?? slug ?? null;
  if (agent) return { agent, label: agent.name, detail: [agent.role === "worker" ? agent.seniority ?? "worker" : agent.role, project] };
  return { agent: null, label: session.agent ?? "New agent", detail: ["not joined", project] };
}

/**
 * The project slug a session belongs to: the one its launch recorded (tmux @hivemind_project), else its agent's.
 * Null when neither is known; such a session counts as another project's.
 */
export function sessionProject(session: TerminalSessionInfo, agents: Agent[]): string | null {
  return session.project ?? agents.find(item => agentTerminalSession(item) === session.name)?.project ?? null;
}

/**
 * A row's state. Running: an agent joined from it. Waiting to join: alive, no agent mapped to it yet. Reconnecting: the
 * broker (or the gateway to it) is gone for now, so the list is the last one known and the agent keeps running. Ended:
 * the broker says the pane is dead.
 */
export type SessionStatus = "running" | "waiting" | "reconnecting" | "ended";

export function sessionStatus(session: TerminalSessionInfo, mapped: boolean, reconnecting: boolean): SessionStatus {
  if (reconnecting) return "reconnecting";
  if (!session.alive) return "ended";
  return mapped ? "running" : "waiting";
}

const STATUS: Record<SessionStatus, { label: string; tone: string }> = {
  running: { label: "Running", tone: "ok" },
  waiting: { label: "Waiting to join", tone: "accent" },
  reconnecting: { label: "Reconnecting", tone: "accent" },
  ended: { label: "Ended", tone: "muted" },
};

/** What Copy attach command copies: tmux attach on Hivemind's own tmux server (docs/terminal-broker.md). */
export const attachCommand = (session: string) => `tmux -L hivemind attach -t ${session}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Group = { slug: string | null; name: string; sessions: TerminalSessionInfo[] };

/**
 * The Terminals sheet (the apps only): one row per tmux session of the current project, with the agent it belongs to.
 * Open shows it here, Terminal.app attaches a window (the Mac only), the row menu copies the attach command or
 * terminates the session after a confirmation, and Terminate all ends every session of the project after one. Other
 * projects' sessions are counted in the footer and shown on request. `initialSession` opens with that session's
 * terminal shown. `project` is the current project's slug; without one it is the initial session's project, and with
 * none known every project's sessions are listed.
 */
export function SessionsSheet({ agents, projects, onClose, loadScreen, initialSession = null, project, onLaunch }: {
  agents: Agent[];
  projects: Project[];
  onClose: () => void;
  loadScreen?: () => Promise<ScreenFactory>;
  initialSession?: string | null;
  project?: string | null;
  /** Opens the Launch agent sheet; no Launch agent button without it. */
  onLaunch?: () => void;
}) {
  const state = useTerminalState();
  const hub = terminalHub();
  // The iPhone/iPad app has no Terminal.app: its sessions show only here, in the page.
  const terminalApp = onMacDesktop(state.platform);
  const [open, setOpen] = useState<string | null>(initialSession);
  // The session last shown here, highlighted in the list once back from its terminal.
  const [current, setCurrent] = useState<string | null>(initialSession);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const othersId = useId();
  const blocker = terminalBlocker(state);
  // Open in Terminal has no answer of its own: a failure (the session just ended, no tmux) arrives as an error.
  const seenError = useRef(state.lastError);
  useEffect(() => {
    if (state.lastError && state.lastError !== seenError.current) setError(state.lastError.message);
    seenError.current = state.lastError;
  }, [state.lastError]);

  // The hub keeps the last complete list for every consumer; it remains a hint until the broker reconnects.
  const reconnecting = state.sessions === null && state.lastKnownSessions != null && state.broker !== "unverified";
  const sessions = state.sessions ?? (reconnecting ? state.lastKnownSessions : null) ?? [];
  const known = state.sessions !== null || reconnecting;

  const ownerOf = (session: TerminalSessionInfo) => sessionOwner(session, agents, projects, state);
  const projectOf = (session: TerminalSessionInfo) => sessionProject(session, agents);
  const projectName = (slug: string | null) => slug === null ? "Unknown project" : projects.find(item => item.slug === slug)?.name ?? slug;

  // The current project: the one given, else the initial session's (the Launch sheet opens this with only that).
  const derived = useRef<string | null>(null);
  if (project === undefined && derived.current === null && initialSession) {
    const initial = sessions.find(item => item.name === initialSession);
    if (initial) derived.current = projectOf(initial);
  }
  const currentProject = project === undefined ? derived.current : project;
  const scoped = currentProject !== null;
  const mine = scoped ? sessions.filter(item => projectOf(item) === currentProject) : sessions;
  const groups: Group[] = [];
  for (const session of scoped ? sessions.filter(item => projectOf(item) !== currentProject) : []) {
    const slug = projectOf(session);
    const group = groups.find(item => item.slug === slug);
    if (group) group.sessions.push(session);
    else groups.push({ slug, name: projectName(slug), sessions: [session] });
  }
  const rank = (slug: string | null) => {
    const index = projects.findIndex(item => item.slug === slug);
    return index >= 0 ? index : slug === null ? projects.length + 1 : projects.length;
  };
  groups.sort((a, b) => rank(a.slug) - rank(b.slug) || a.name.localeCompare(b.name));
  const otherCount = groups.reduce((total, group) => total + group.sessions.length, 0);
  const title = scoped ? projectName(currentProject) : "All projects";

  const openHere = (name: string) => { setError(null); setNotice(null); setOpen(name); setCurrent(name); };
  const openInTerminal = (name: string) => {
    setError(null);
    if (!hub?.open(name)) setError("Could not ask Hivemind to open Terminal.");
  };
  const copyAttach = (name: string) => {
    setError(null);
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard) { setError("Could not copy: no clipboard here."); return; }
    clipboard.writeText(attachCommand(name))
      .then(() => setNotice(`Copied ${attachCommand(name)}`), () => setError("Could not copy the attach command."));
  };
  const terminate = async () => {
    if (!hub || !confirm) return;
    setBusy(true);
    setError(null);
    try {
      await hub.kill(confirm);
      if (open === confirm) setOpen(null);
      setConfirm(null);
    } catch (e) {
      setError(`Could not terminate ${confirm}: ${(e as Error).message}`);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };
  const terminateAll = async () => {
    if (!hub || !confirmAll) return;
    setBusy(true);
    setError(null);
    try {
      const result = await hub.killAll(confirmAll);
      // A session that had already ended is as good as terminated.
      const failed = result.errors.filter(item => item.code !== "no-such-session");
      if (failed.length > 0) {
        setError(`Could not terminate ${failed.map(item => item.session).join(", ")}: ${failed[0]!.message}`);
      }
    } catch (e) {
      setError(`Could not terminate the sessions: ${(e as Error).message}`);
    } finally {
      setConfirmAll(null);
      setBusy(false);
    }
  };

  const row = (session: TerminalSessionInfo) => {
    const owner = ownerOf(session);
    const runtime = owner.agent ? agentRuntime(owner.agent, { agents }, state) : null;
    return (
      <SessionRow key={session.name} session={session} agent={owner.agent} label={owner.label}
        status={sessionStatus(session, runtime?.sessionName === session.name, reconnecting)} current={session.name === current}
        terminalApp={terminalApp} onOpen={() => openHere(session.name)} onTerminal={() => openInTerminal(session.name)}
        onCopy={() => copyAttach(session.name)} onTerminate={() => { setError(null); setConfirm(session.name); }} />
    );
  };

  const viewing = open ? sessions.find(item => item.name === open) : undefined;
  const viewingOwner = viewing ? ownerOf(viewing) : null;
  return (
    <Modal onClose={confirm || confirmAll ? undefined : onClose}>
      <div className="sheet sheet-wide sessions-sheet" role="dialog" aria-modal="true" aria-label="Terminals"
        onClick={event => event.stopPropagation()}>
        <header className="sheet-head">
          {open ? (
            <button type="button" className="icon-btn" aria-label="All sessions" title="All sessions" onClick={() => setOpen(null)}>
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
          ) : <span className="sheet-icon" aria-hidden="true"><SquareTerminal size={18} /></span>}
          <div>
            <h2>{open ? viewingOwner?.label ?? open : "Terminals"}</h2>
            <p>{open ? <code>{open}</code>
              : `${title} · ${plural(mine.length, "session")} · closing a view keeps the agent running`}</p>
          </div>
          {open && terminalApp && (
            <button type="button" className="btn" onClick={() => openInTerminal(open)}>
              <Monitor size={13} aria-hidden="true" /> Open in Terminal
            </button>
          )}
          {!open && (
            <div className="term-head-actions">
              <button type="button" className="btn btn-danger" disabled={!hub || mine.length === 0 || reconnecting || busy}
                onClick={() => { setError(null); setConfirmAll(mine.map(item => item.name)); }}>
                <Trash2 size={14} aria-hidden="true" /> Terminate all
              </button>
              {onLaunch && (
                <button type="button" className="btn btn-primary" onClick={onLaunch}>
                  <Plus size={14} aria-hidden="true" /> Launch agent
                </button>
              )}
            </div>
          )}
          <button type="button" className="icon-btn" aria-label="Close dialog" title="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="sheet-body">
          {error && <p className="err" role="alert">{error}</p>}
          {open ? <TerminalPanel session={open} loadScreen={loadScreen} /> : <>
            {notice && <p className="term-copied" role="status">{notice}</p>}
            {blocker && <TerminalNotice blocker={blocker} />}
            {known && mine.length === 0 && (
              <div className="term-empty-state">
                <strong>{scoped ? `No terminals in ${title} yet` : "No terminals yet"}</strong>
                <span>Launch an agent and its tmux session appears here.</span>
                {onLaunch && (
                  <button type="button" className="btn btn-primary" onClick={onLaunch}>
                    <Plus size={14} aria-hidden="true" /> Launch agent
                  </button>
                )}
              </div>
            )}
            {mine.length > 0 && (
              <section className="term-group" aria-label={`${title} sessions`}>
                {showAll && otherCount > 0 && <h3>{title} <small>this project</small></h3>}
                <ul className="term-rows">{mine.map(row)}</ul>
              </section>
            )}
            {showAll && groups.length > 0 && (
              <div id={othersId} className="term-others">
                {groups.map(group => (
                  <section key={group.slug ?? ""} className="term-group" aria-label={`${group.name} sessions`}>
                    <h3>{group.name} <em className="count soft">{group.sessions.length}</em></h3>
                    <ul className="term-rows">{group.sessions.map(row)}</ul>
                  </section>
                ))}
              </div>
            )}
          </>}
        </div>
        {!open && otherCount > 0 && (
          <footer className="term-foot">
            <span>
              Only this project's sessions are shown. Other projects have {otherCount}:{" "}
              {groups.map(group => `${group.name} (${group.sessions.length})`).join(", ")}.
            </span>
            <button type="button" className="btn" aria-expanded={showAll} aria-controls={showAll ? othersId : undefined}
              onClick={() => setShowAll(value => !value)}>
              {showAll ? "Hide other projects" : "Show all projects"}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          </footer>
        )}
      </div>
      {confirm && (
        <TerminateConfirm session={confirm} owner={sessions.find(item => item.name === confirm)} agents={agents} projects={projects}
          busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => void terminate()} />
      )}
      {confirmAll && (
        <TerminateAllConfirm sessions={confirmAll} project={title} busy={busy} onCancel={() => setConfirmAll(null)}
          onConfirm={() => void terminateAll()} />
      )}
    </Modal>
  );
}

function SessionRow({ session, agent, label, status, current, terminalApp, onOpen, onTerminal, onCopy, onTerminate }: {
  session: TerminalSessionInfo;
  agent: Agent | null;
  label: string;
  status: SessionStatus;
  current: boolean;
  terminalApp: boolean;
  onOpen: () => void;
  onTerminal: () => void;
  onCopy: () => void;
  onTerminate: () => void;
}) {
  const role = agent ? agent.role === "worker" ? agent.seniority ? `worker · ${agent.seniority}` : "worker" : agent.role : null;
  const { label: statusLabel, tone } = STATUS[status];
  const ended = status === "ended";
  return (
    <li className="term-row" data-status={status} aria-current={current ? "true" : undefined}>
      <Avatar name={label} role={agent?.role} />
      <div className="term-who">
        <span className="term-name">
          <strong>{label}</strong>
          {role && <span className="term-role">{role}</span>}
        </span>
        <code className="term-session">{session.name}</code>
      </div>
      <span className={`tone-chip ${tone}`}>{statusLabel}</span>
      <span className="term-meta">
        started <RelativeTime at={session.createdAt} />
        {status === "reconnecting" ? " · the agent keeps running"
          : ended ? " · ended"
          : status === "waiting" ? session.attached > 0 ? ` · ${session.attached} attached · not joined yet` : " · not joined yet"
          : session.attached > 0 ? ` · ${session.attached} attached` : ""}
      </span>
      <div className="term-actions">
        <button type="button" className="btn btn-primary" disabled={ended} onClick={onOpen} aria-label={`Open ${session.name}`}>
          <SquareTerminal size={14} aria-hidden="true" /> Open
        </button>
        {terminalApp && (
          <button type="button" className="btn" disabled={ended || status === "reconnecting"} onClick={onTerminal}
            aria-label={`Open ${session.name} in Terminal`} title="Open in Terminal.app">
            <Monitor size={14} aria-hidden="true" /> Terminal.app
          </button>
        )}
        <RowMenu session={session.name} canTerminate={status !== "reconnecting"} onCopy={onCopy} onTerminate={onTerminate} />
      </div>
    </li>
  );
}

/** The row's ⋯ menu: arrows, Home/End, Escape and Tab as the sidebar's menus (web/menu-keys.ts). */
function RowMenu({ session, canTerminate, onCopy, onTerminate }: {
  session: string;
  canTerminate: boolean;
  onCopy: () => void;
  onTerminate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    focusFirstMenuItem(menu.current);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = (action: () => void) => { setOpen(false); trigger.current?.focus(); action(); };
  return (
    <div className="term-menu-box" ref={box}>
      <button type="button" className="icon-btn" ref={trigger} aria-label={`More actions for ${session}`} title="More actions"
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <Ellipsis size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="person-menu term-menu" role="menu" aria-label={`Actions for ${session}`} ref={menu}
          onKeyDown={event => menuKeyDown(event, trigger, () => setOpen(false))}>
          <button type="button" role="menuitem" onClick={() => choose(onCopy)}>Copy attach command</button>
          <button type="button" role="menuitem" className="bad" disabled={!canTerminate} onClick={() => choose(onTerminate)}>
            Terminate
          </button>
        </div>
      )}
    </div>
  );
}

function TerminateConfirm({ session, owner, agents, projects, busy, onCancel, onConfirm }: {
  session: string;
  owner: TerminalSessionInfo | undefined;
  agents: Agent[];
  projects: Project[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const who = owner ? sessionOwner(owner, agents, projects) : null;
  return (
    <Modal onClose={() => !busy && onCancel()}>
      <div className="sheet" role="alertdialog" aria-modal="true" aria-label={`Terminate ${session}`} onClick={event => event.stopPropagation()}>
        <h2>Terminate {who?.agent ? who.label : "session"}?</h2>
        <p className="help-p">
          Ends the tmux session <code>{session}</code> and everything running in it{who?.agent ? `, including ${who.label}’s CLI` : ""}.
          Terminal windows attached to it close. The agent stays in the hive with its messages; launch it again to resume.
        </p>
        <div className="row">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Terminating…" : "Terminate"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Terminate all: names the project's sessions (the first three, then how many more) before ending them all. */
function TerminateAllConfirm({ sessions, project, busy, onCancel, onConfirm }: {
  sessions: string[];
  project: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = sessions.length;
  const shown = sessions.slice(0, 3);
  return (
    <Modal onClose={() => !busy && onCancel()}>
      <div className="sheet terminate-all" role="alertdialog" aria-modal="true" aria-label="Terminate all sessions"
        onClick={event => event.stopPropagation()}>
        <span className="terminate-all-icon" aria-hidden="true"><Trash2 size={18} /></span>
        <h2>{count === 1 ? `Terminate the 1 session in ${project}?` : `Terminate all ${count} sessions in ${project}?`}</h2>
        <p className="help-p">
          Every agent in these sessions stops at once and unsaved work in their terminals is lost. Other projects' sessions
          are not touched.
        </p>
        <ul className="terminate-all-list" aria-label="Sessions to terminate">
          {shown.map(name => <li key={name}>{name}</li>)}
          {count > shown.length && <li>+ {count - shown.length} more</li>}
        </ul>
        <div className="row">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="danger-fill" onClick={onConfirm} disabled={busy}>
            {busy ? "Terminating…" : `Terminate ${plural(count, "session")}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
