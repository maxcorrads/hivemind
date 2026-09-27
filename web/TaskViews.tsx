import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { TaskControlInput } from '../src/shared/task-control.ts';
import type { TaskOverview, TaskViewsPage } from '../src/shared/task-views.ts';
import type { AgentTrafficView, Agent, Project } from '../src/shared/types.ts';
import { agentRuntime } from './agent-runtime.ts';
import { api, ApiError } from './api.ts';
import { BackButton } from './MobileNav.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import { SessionsSheet } from './SessionsSheet.tsx';
import { TaskChip, TaskStepper } from './TaskCard.tsx';
import { controlBody, groupTaskViews, mergeTaskPages, taskControls, workerTrafficLabel } from './task-views-model.ts';
import { useTerminalState } from './use-terminal.ts';

type Pending = { body: TaskControlInput; state: 'sending' | 'unknown'; message: string | null; checked: boolean };
type Props = {
  project: string | null;
  projects: Project[];
  agents: Agent[];
  traffic: Record<string, AgentTrafficView>;
  tick: number;
  requests?: ReactNode;
  onProject: (slug: string) => void;
  onBack: () => void;
  onAll: () => void;
  onOpenThread: (item: TaskOverview) => void;
  onMessageBrain: (item: TaskOverview) => void;
};

/** Cross-channel task list. Every card is server-projected, including historical agent/template labels. */
export function TaskViews({ project, projects, agents, traffic, tick, requests, onProject, onBack, onAll, onOpenThread, onMessageBrain }: Props) {
  const [page, setPage] = useState<TaskViewsPage | null>(null);
  const [pageScope, setPageScope] = useState<string | null>(project);
  const [loading, setLoading] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const [error, setError] = useState<{ scope: number; message: string } | null>(null);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const generation = useRef(0);
  const scopeVersion = useRef(0);
  const lastScope = useRef(project);
  if (lastScope.current !== project) { lastScope.current = project; scopeVersion.current++; }
  const terminals = useTerminalState();
  const [terminalSession, setTerminalSession] = useState<string | null>(null);
  const projectName = projects.find(item => item.slug === project)?.name ?? project;

  const load = useCallback(async (cursor: string | null = null) => {
    const scope = scopeVersion.current;
    const ticket = ++generation.current;
    if (cursor) setOlderLoading(true); else setLoading(true);
    try {
      const result = await api.tasks(project, cursor);
      if (ticket !== generation.current || scope !== scopeVersion.current) return;
      setPageScope(project);
      setPage(previous => cursor && previous ? mergeTaskPages(previous, result) : result);
      setError(null);
    } catch (failure) {
      if (ticket === generation.current && scope === scopeVersion.current)
        setError({ scope, message: String((failure as Error).message || failure) });
    } finally {
      if (ticket === generation.current && scope === scopeVersion.current) { setLoading(false); setOlderLoading(false); }
    }
  }, [project]);

  useEffect(() => {
    setPage(null);
    void load();
    return () => { generation.current++; };
  }, [load, tick]);

  const refreshItem = useCallback(async (id: string) => {
    const scope = scopeVersion.current;
    const { item } = await api.task(id);
    if (scope === scopeVersion.current)
      setPage(current => current ? { ...current, items: current.items.map(old => old.task.id === id ? item : old) } : current);
    return item;
  }, []);

  const submit = async (id: string, body: TaskControlInput) => {
    const scope = scopeVersion.current;
    setPending(current => ({ ...current, [id]: { body, state: 'sending', message: null, checked: false } }));
    try {
      const result = await api.controlTask(id, body);
      if (scope === scopeVersion.current) setPage(current => current ? { ...current, items: current.items.map(item => item.task.id === id
        ? { ...item, task: result.task, controls: { retryClose: false, resume: false } } : item) } : current);
      setPending(current => { const next = { ...current }; delete next[id]; return next; });
      if (scope === scopeVersion.current) void load();
    } catch (failure) {
      const message = String((failure as Error).message || failure);
      if (scope !== scopeVersion.current) {
        setPending(current => ({ ...current, [id]: { body, state: 'unknown', message, checked: false } }));
        return;
      }
      let changed = false;
      try { changed = (await refreshItem(id)).task.revision !== body.expectedRevision; } catch { /* keep unknown outcome */ }
      if (scope !== scopeVersion.current) return;
      if (changed || failure instanceof ApiError && failure.status < 500) {
        setPending(current => { const next = { ...current }; delete next[id]; return next; });
        setError({ scope, message: changed ? 'Task changed. Review its current state before another action.' : message });
      } else {
        // Network loss or a server error may have happened after commit. Reuse the exact body on an explicit retry.
        setPending(current => ({ ...current, [id]: { body, state: 'unknown', message, checked: false } }));
      }
    }
  };

  const checkUnknown = async (id: string, entry: Pending) => {
    const scope = scopeVersion.current;
    try {
      const item = await refreshItem(id);
      if (scope !== scopeVersion.current) return;
      if (item.task.revision !== entry.body.expectedRevision) {
        setPending(current => { const next = { ...current }; delete next[id]; return next; });
        setError({ scope, message: 'Task changed. Review its current state before another action.' });
      } else setPending(current => ({ ...current, [id]: { ...entry, checked: true,
        message: 'No change recorded. Retry will reuse this request ID.' } }));
    } catch (failure) {
      if (scope !== scopeVersion.current) return;
      setPending(current => ({ ...current, [id]: { ...entry, checked: false,
        message: `Could not check the task: ${String((failure as Error).message || failure)}` } }));
    }
  };

  const act = (item: TaskOverview, action: TaskControlInput['action']) =>
    void submit(item.task.id, controlBody(item.task, action, crypto.randomUUID()));
  const visiblePage = pageScope === project ? page : null;
  const visibleError = error?.scope === scopeVersion.current ? error.message : null;
  const groups = visiblePage ? groupTaskViews(visiblePage) : [];
  return <>
    <header className="desk-h task-view-head">
      {project && <BackButton label="Back to project" onBack={onBack} />}
      <div><h1>{project ? `Tasks · ${projectName}` : 'All tasks'}</h1>
        <p>Jobs and work across {project ? 'this project' : 'all projects'}.</p></div>
      <button type="button" className="btn" disabled={loading} onClick={() => void load()}>Refresh</button>
    </header>
    <div className="stream task-view-stream">
      <nav className="task-scope" aria-label="Task scope">
        {project ? <button type="button" className="btn" onClick={onAll}>All tasks</button>
          : projects.map(item => <button type="button" className="btn" key={item.id} onClick={() => onProject(item.slug)}>{item.name}</button>)}
      </nav>
      {requests}
      {visibleError && <p className="err" role="alert">{visibleError} <button type="button" onClick={() => void load()}>Refresh</button></p>}
      {(loading || pageScope !== project) && !visiblePage && <p role="status" className="empty">Loading tasks…</p>}
      {!loading && !visiblePage && visibleError && <p className="empty">Tasks could not be loaded. Refresh to try again.</p>}
      {!loading && visiblePage && groups.length === 0 && <p className="empty">No tasks or active jobs in this scope.</p>}
      {groups.map(group => <section className="task-view-group" key={group.job?.id ?? 'ungrouped'}
        aria-label={group.job?.title ?? 'Tasks without a job'}>
        <header className="task-view-group-head">
          <div><h2>{group.job?.title ?? 'Tasks without a job'}</h2>
            {group.job && <p>{group.items[0]?.task.assignerName ?? agents.find(agent => agent.id === group.job!.brainId)?.name ?? 'Brain'} · {group.job.state} ·
              {' '}{group.job.counts.completed}/{group.job.counts.total} complete · {group.job.counts.active} active</p>}</div>
        </header>
        {group.items.length === 0 && <p className="empty">No tasks in this job yet.</p>}
        {group.items.map(item => <TaskOverviewCard key={item.task.id} item={item} project={project}
          traffic={item.traffic ?? traffic[item.worker.id]} runtime={agentRuntime(agents.find(agent => agent.id === item.worker.id) ?? item.worker,
            { agents }, terminals)} pending={pending[item.task.id]} actionDisabled={loading || Boolean(visibleError)}
          onAct={action => act(item, action)}
          onCheck={() => void checkUnknown(item.task.id, pending[item.task.id]!)}
          onRetry={() => void submit(item.task.id, pending[item.task.id]!.body)}
          onOpenThread={() => onOpenThread(item)} onMessageBrain={() => onMessageBrain(item)}
          onTerminal={name => setTerminalSession(name)} />)}
      </section>)}
      {visiblePage?.hasMore && <button type="button" className="btn task-more" disabled={olderLoading || !visiblePage.nextCursor}
        onClick={() => void load(visiblePage.nextCursor)}>{olderLoading ? 'Loading…' : 'Load older tasks'}</button>}
    </div>
    {terminalSession && <SessionsSheet agents={agents} projects={projects} project={project}
      initialSession={terminalSession} onClose={() => setTerminalSession(null)} />}
  </>;
}

function TaskOverviewCard({ item, project, traffic, runtime, pending, actionDisabled, onAct, onCheck, onRetry, onOpenThread,
  onMessageBrain, onTerminal }: {
  item: TaskOverview; project: string | null; traffic: AgentTrafficView | undefined;
  runtime: ReturnType<typeof agentRuntime>; pending?: Pending;
  actionDisabled: boolean;
  onAct: (action: TaskControlInput['action']) => void; onCheck: () => void; onRetry: () => void;
  onOpenThread: () => void; onMessageBrain: () => void; onTerminal: (name: string) => void;
}) {
  const { task, brain, template } = item;
  const controls = taskControls(item);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const busy = Boolean(pending) || actionDisabled;
  return <article className="task-view-card" aria-label={`Task ${task.id}`}>
    <div className="task-view-card-top"><TaskChip state={task.state} />
      <span>Updated <RelativeTime at={task.updatedAt} /></span></div>
    <h3>{task.contract.objective}</h3>
    <p className="task-view-meta">{!project && <>{item.project} · </>}{task.workerName} · {template?.label ?? 'No template'} · Brain {task.assignerName}</p>
    <TaskStepper state={task.state} />
    {task.checkpoint && <div className="task-view-checkpoint">
      <strong>Latest checkpoint · <RelativeTime at={task.checkpoint.savedAt} /></strong>
      <p>Completed: {task.checkpoint.data.completedSteps.join('; ') || 'none reported'}</p>
      <p>Open questions: {task.checkpoint.data.unresolvedQuestions.join('; ') || 'none reported'}</p>
      <p>Next action: {task.checkpoint.data.nextAction}</p>
      <small>Worker report; later unsaved work may exist.</small>
    </div>}
    {task.pause && <p className="task-view-pause" role="status">{task.pause.mode === 'hard' ? 'Hard' : 'Soft'} pause ·
      {' '}{item.controls.retryClose ? 'worker session close failed; retry needed' :
        task.pause.closedAt ? 'worker session closed' : task.pause.stopRequestedAt ? 'waiting for worker session to close' :
        task.pause.graceUntil ? <>grace ends <RelativeTime at={task.pause.graceUntil} /></> : 'worker asked to stop'}
      {task.pause.resumeRequestId ? ' · resume requested' : ''}</p>}
    <p className="task-view-traffic" title={traffic ? `Counter started ${new Date(traffic.since).toLocaleString()}` : undefined}>
      {task.workerName} · {workerTrafficLabel(traffic)} <small>(agent-wide, not task-specific)</small>
    </p>
    {runtime.sessionName && (runtime.sessionState === 'running' || runtime.sessionState === 'reconnecting') && <p className="task-view-terminal">
      Terminal · {runtime.sessionState} · <button type="button" onClick={() => onTerminal(runtime.sessionName!)}>Open {runtime.sessionName}</button>
    </p>}
    <div className="task-view-actions">
      <button type="button" className="btn" onClick={onOpenThread}>Open thread</button>
      <button type="button" className="btn" disabled={brain.removedAt !== undefined || brain.archivedAt !== undefined}
        title={brain.removedAt !== undefined || brain.archivedAt !== undefined ? 'This brain is no longer available for direct messages' : undefined}
        onClick={onMessageBrain}>Message brain</button>
      {controls.pauseSoft && <button type="button" className="btn" disabled={busy} onClick={() => onAct({ type: 'pause', mode: 'soft' })}>Pause soft</button>}
      {controls.pauseHard && <button type="button" className="btn" disabled={busy} onClick={() => onAct({ type: 'pause', mode: 'hard' })}>Pause hard</button>}
      {controls.retryClose && <button type="button" className="btn" disabled={busy} onClick={() => onAct({ type: 'pause', mode: 'hard' })}>Retry close</button>}
      {controls.resume && <button type="button" className="btn" disabled={busy} onClick={() => onAct({ type: 'resume' })}>Resume</button>}
      {controls.cancel && <button type="button" className="btn btn-danger" disabled={busy} aria-expanded={cancelOpen}
        onClick={() => setCancelOpen(value => !value)}>Cancel task</button>}
    </div>
    {cancelOpen && controls.cancel && <form className="task-view-cancel" onSubmit={event => {
      event.preventDefault();
      if (!cancelReason.trim()) return;
      onAct({ type: 'cancel', reason: cancelReason.trim() });
      setCancelOpen(false);
    }}>
      <label>Reason for cancellation <textarea required maxLength={700} value={cancelReason}
        onChange={event => setCancelReason(event.target.value)} /></label>
      <button type="submit" className="btn btn-danger" disabled={busy || !cancelReason.trim()}>Confirm cancellation</button>
    </form>}
    {pending?.state === 'sending' && <p role="status">Sending task control…</p>}
    {pending?.state === 'unknown' && <div className="task-view-unknown" role="alert">
      <p>Outcome unknown: {pending.message}. Check the task before retrying.</p>
      <button type="button" className="btn" onClick={onCheck}>Check status</button>
      <button type="button" className="btn" disabled={!pending.checked} onClick={onRetry}>Retry same request</button>
    </div>}
  </article>;
}
