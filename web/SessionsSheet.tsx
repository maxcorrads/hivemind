import { ArrowLeft, Monitor, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Agent, Project } from "../src/shared/types.ts";
import { Modal } from "./Modal.tsx";
import { onMacDesktop, type TerminalSessionInfo } from "./native-bridge.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { TerminalNotice } from "./TerminalNotice.tsx";
import { TerminalPanel, type ScreenFactory } from "./TerminalView.tsx";
import { agentTerminalSession, terminalBlocker, terminalHub, useTerminalState } from "./use-terminal.ts";

/** Who a session belongs to: the agent that reported it on join, else what the launch recorded. */
export function sessionOwner(session: TerminalSessionInfo, agents: Agent[], projects: Project[]) {
  const agent = agents.find(item => agentTerminalSession(item) === session.name);
  const slug = agent?.project ?? session.project;
  const project = projects.find(item => item.slug === slug)?.name ?? slug ?? null;
  if (agent) return { agent, label: agent.name, detail: [agent.role === "worker" ? agent.seniority ?? "worker" : agent.role, project] };
  return { agent: null, label: session.agent ?? "New agent", detail: ["not joined", project] };
}

/**
 * Every Hivemind tmux session (the apps only), with the agent it belongs to: open it here or, on the Mac, in
 * Terminal.app, or terminate it after a confirmation. `initialSession` opens with that session's terminal shown.
 */
export function SessionsSheet({ agents, projects, onClose, loadScreen, initialSession = null }: {
  agents: Agent[];
  projects: Project[];
  onClose: () => void;
  loadScreen?: () => Promise<ScreenFactory>;
  initialSession?: string | null;
}) {
  const state = useTerminalState();
  const hub = terminalHub();
  // The iPhone/iPad app has no Terminal.app: its sessions show only here, in the page.
  const terminalApp = onMacDesktop(state.platform);
  const [open, setOpen] = useState<string | null>(initialSession);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocker = terminalBlocker(state);
  // Open in Terminal has no answer of its own: a failure (the session just ended, no tmux) arrives as an error.
  const seenError = useRef(state.lastError);
  useEffect(() => {
    if (state.lastError && state.lastError !== seenError.current) setError(state.lastError.message);
    seenError.current = state.lastError;
  }, [state.lastError]);
  const sessions = state.sessions ?? [];
  const ownerOf = (session: TerminalSessionInfo) => sessionOwner(session, agents, projects);

  const openInTerminal = (name: string) => {
    setError(null);
    if (!hub?.open(name)) setError("Could not ask Hivemind to open Terminal.");
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

  const viewing = open ? sessions.find(item => item.name === open) : undefined;
  const viewingOwner = viewing ? ownerOf(viewing) : null;
  return (
    <Modal onClose={confirm ? undefined : onClose}>
      <div className="sheet sheet-wide sessions-sheet" role="dialog" aria-modal="true" aria-label="Terminal sessions"
        onClick={event => event.stopPropagation()}>
        <header className="sheet-head">
          {open ? (
            <button type="button" className="icon-btn" aria-label="All sessions" title="All sessions" onClick={() => setOpen(null)}>
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
          ) : <span className="sheet-icon" aria-hidden="true"><SquareTerminal size={18} /></span>}
          <div>
            <h2>{open ? viewingOwner?.label ?? open : "Terminal sessions"}</h2>
            <p>{open ? <code>{open}</code>
              : terminalApp ? "Agents launched from Hivemind run in these tmux sessions. Closing a window keeps the session running."
                : "Agents launched from Hivemind run in these tmux sessions on your Mac. Closing this keeps them running."}</p>
          </div>
          {open && terminalApp && (
            <button type="button" className="btn" onClick={() => openInTerminal(open)}>
              <Monitor size={13} aria-hidden="true" /> Open in Terminal
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Close dialog" title="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="sheet-body">
          {error && <p className="err" role="alert">{error}</p>}
          {open ? <TerminalPanel session={open} loadScreen={loadScreen} /> : <>
            {blocker && <TerminalNotice blocker={blocker} />}
            {state.sessions && sessions.length === 0 && (
              <p className="empty">No sessions. Launch an agent from Launch agent to start one.</p>
            )}
            {sessions.length > 0 && (
              <ul className="session-list" aria-label="Sessions">
                {sessions.map(session => {
                  const owner = ownerOf(session);
                  return (
                    <li key={session.name} className={session.alive ? "alive" : "dead"}>
                      <i className={`sdot ${session.alive ? "ok" : ""}`} aria-hidden="true" />
                      <div className="session-main">
                        <strong>{owner.label}</strong>
                        <small>
                          {owner.detail.filter(Boolean).join(" · ")}
                          {" · "}{session.alive ? "running" : "exited"}
                          {" · "}{session.attached} attached
                          {" · started "}<RelativeTime at={session.createdAt} />
                        </small>
                        <code>{session.name}</code>
                      </div>
                      <div className="session-actions">
                        <button type="button" className="btn" disabled={!session.alive} onClick={() => { setError(null); setOpen(session.name); }}
                          aria-label={`Open ${session.name}`}>
                          <SquareTerminal size={13} aria-hidden="true" /> Open
                        </button>
                        {terminalApp && (
                          <button type="button" className="btn" disabled={!session.alive} onClick={() => openInTerminal(session.name)}
                            aria-label={`Open ${session.name} in Terminal`} title="Open in Terminal.app">
                            <Monitor size={13} aria-hidden="true" /> Terminal
                          </button>
                        )}
                        <button type="button" className="btn danger" onClick={() => { setError(null); setConfirm(session.name); }}
                          aria-label={`Terminate ${session.name}`} title="Terminate">
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>}
        </div>
      </div>
      {confirm && (
        <TerminateConfirm session={confirm} owner={sessions.find(item => item.name === confirm)} agents={agents} projects={projects}
          busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => void terminate()} />
      )}
    </Modal>
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
