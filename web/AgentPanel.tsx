import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { Agent, Project } from '../src/shared/types.ts';
import type { AgentOverview, AgentRemoveImpact, AgentLifecycleEvent } from '../src/shared/agent-management.ts';
import { capabilityCardSchema, type CapabilityCard } from '../src/shared/routing.ts';
import { agentLabel } from '../src/shared/types.ts';
import { agentRuntime, verifiedStopSession } from './agent-runtime.ts';
import { api, ApiError } from './api.ts';
import { Modal } from './Modal.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import { SessionsSheet } from './SessionsSheet.tsx';
import { TaskChip } from './TaskCard.tsx';
import { workerTrafficLabel } from './task-views-model.ts';
import { terminalHub, useTerminalState } from './use-terminal.ts';

type IdentityDraft = { name: string; focus: string; seniority: 'junior' | 'mid' | 'senior' | '' };
type CapabilityDraft = { enabled: boolean; capabilities: string; modes: CapabilityCard['modes']; model: string;
  host: string; availableContext: string; availability: CapabilityCard['availability']; maxInProgress: string };

function identityDraft(agent: Agent): IdentityDraft {
  return { name: agent.name, focus: agent.focus ?? '', seniority: agent.seniority ?? '' };
}
function capabilityDraft(card: CapabilityCard | null): CapabilityDraft {
  return { enabled: card?.enabled ?? false, capabilities: card?.capabilities.join(', ') ?? '', modes: card?.modes ?? [],
    model: card?.model ?? '', host: card?.host ?? '', availableContext: card?.availableContext?.toString() ?? '',
    availability: card?.availability ?? 'unavailable', maxInProgress: card?.maxInProgress?.toString() ?? '' };
}
export function capabilityInput(draft: CapabilityDraft): CapabilityCard {
  return capabilityCardSchema.parse({ enabled: draft.enabled,
    capabilities: draft.capabilities.split(',').map(value => value.trim()).filter(Boolean), modes: draft.modes,
    model: draft.model.trim() || null, host: draft.host.trim() || null,
    availableContext: draft.availableContext.trim() ? Number(draft.availableContext) : null,
    availability: draft.availability, maxInProgress: Number(draft.maxInProgress) });
}

export function AgentPanel({ agentId, agents, projects, tick, onClose, onMessage, onClear, onResume, onOpenTask, onOpenThread, onChanged }: {
  agentId: string; agents: Agent[]; projects: Project[]; tick: number; onClose: () => void; onMessage: (agent: Agent) => void;
  onClear: (agent: Agent) => void;
  onResume: (agent: Agent, resumeAliases: string[]) => void; onOpenTask: (item: NonNullable<AgentOverview['currentTask']>) => void;
  onOpenThread: (item: NonNullable<AgentOverview['currentTask']>) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [overview, setOverview] = useState<AgentOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<IdentityDraft | null>(null);
  const [capability, setCapability] = useState<CapabilityDraft | null>(null);
  const [identityConflict, setIdentityConflict] = useState(false);
  const [capabilityConflict, setCapabilityConflict] = useState(false);
  const identityBase = useRef<number | null>(null);
  const capabilityBase = useRef<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [impact, setImpact] = useState<AgentRemoveImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [stopOnRemove, setStopOnRemove] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [stopResult, setStopResult] = useState<string | null>(null);
  const [terminalSession, setTerminalSession] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<AgentLifecycleEvent[]>([]);
  const [olderBefore, setOlderBefore] = useState<number | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const terminals = useTerminalState();
  const generation = useRef(0);

  const load = useCallback(async (resetDraft: 'both' | 'identity' | 'capability' | false = false) => {
    const ticket = ++generation.current;
    setLoading(true);
    try {
      const result = await api.agentOverview(agentId);
      if (ticket !== generation.current) return;
      setOverview(result);
      setLifecycle(result.lifecycle);
      setOlderBefore(result.lifecycle.at(-1)?.seq ?? null);
      if (resetDraft === 'both' || resetDraft === 'identity') {
        setIdentity(identityDraft(result.agent)); identityBase.current = result.identityRevision; setIdentityConflict(false);
      } else {
        setIdentity(value => value ?? identityDraft(result.agent));
        if (identityBase.current !== null && identityBase.current !== result.identityRevision) setIdentityConflict(true);
      }
      if (resetDraft === 'both' || resetDraft === 'capability') {
        setCapability(capabilityDraft(result.capability?.card ?? null));
        capabilityBase.current = result.capability?.revision ?? 0; setCapabilityConflict(false);
      } else {
        setCapability(value => value ?? capabilityDraft(result.capability?.card ?? null));
        if (capabilityBase.current !== null && capabilityBase.current !== (result.capability?.revision ?? 0))
          setCapabilityConflict(true);
      }
      setError(null);
    } catch (failure) { if (ticket === generation.current) setError(String((failure as Error).message || failure)); }
    finally { if (ticket === generation.current) setLoading(false); }
  }, [agentId]);
  useEffect(() => { void load('both'); return () => { generation.current++; }; }, [load]);
  // Realtime events refresh observations, but never replace an in-progress edit.
  useEffect(() => { if (tick) void load(); }, [tick, load]);

  const agent = overview?.agent;
  const active = agent && agent.removedAt === undefined && agent.archivedAt === undefined;
  const fixed = overview?.profile.type === 'fixed';
  const runtime = agent ? agentRuntime(agent, { agents }, terminals, overview?.work ?? undefined) : null;
  const stopSession = agent ? verifiedStopSession(agent, agents, terminals, overview?.resumeAliases ?? []) : null;

  const saveIdentity = async (event: FormEvent) => {
    event.preventDefault();
    if (!agent || !identity || !overview || identityConflict) return;
    const body: { expectedRevision: number; name?: string; focus?: string | null; seniority?: 'junior' | 'mid' | 'senior' } =
      { expectedRevision: identityBase.current ?? overview.identityRevision };
    if (identity.name.trim() !== agent.name) body.name = identity.name.trim();
    if (identity.focus.trim() !== (agent.focus ?? '')) body.focus = identity.focus.trim() || null;
    if (identity.seniority && identity.seniority !== agent.seniority) body.seniority = identity.seniority;
    if (Object.keys(body).length === 1) return;
    setBusy('identity'); setActionError(null);
    try {
      await api.editAgentIdentity(agentId, body);
      await onChanged(); await load('identity');
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setIdentityConflict(true); await load();
        setActionError('Identity changed elsewhere. Review the current values, then reload the form before editing again.');
      } else setActionError(String((failure as Error).message || failure));
    } finally { setBusy(null); }
  };
  const saveCapability = async (event: FormEvent) => {
    event.preventDefault();
    if (!capability || !overview || capabilityConflict) return;
    let card: CapabilityCard;
    try { card = capabilityInput(capability); } catch (failure) {
      setActionError(`Check capability fields: ${String((failure as Error).message || failure)}`); return;
    }
    setBusy('capability'); setActionError(null);
    try {
      await api.editAgentCapability(agentId, { expectedRevision: capabilityBase.current ?? overview.capability?.revision ?? 0, card });
      await onChanged(); await load('capability');
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setCapabilityConflict(true); await load();
        setActionError('Capability changed elsewhere. Review the current card, then reload the form before editing again.');
      } else setActionError(String((failure as Error).message || failure));
    } finally { setBusy(null); }
  };
  const requestImpact = async () => {
    setImpactLoading(true); setActionError(null);
    try { setImpact(await api.agentRemoveImpact(agentId)); }
    catch (failure) { setActionError(String((failure as Error).message || failure)); }
    finally { setImpactLoading(false); }
  };
  const observeStop = async (session: string) => {
    const logErrors: string[] = [];
    const hub = terminalHub();
    if (!hub) throw new Error('Native terminal broker is unavailable.');
    try { await api.agentRuntimeEvent(agentId, 'stop_requested', session); }
    catch { logErrors.push('Could not record the stop request in the lifecycle log.'); }
    await hub.kill(session);
    try { await api.agentRuntimeEvent(agentId, 'stop_observed', session); }
    catch { logErrors.push('Session closed, but the lifecycle log could not record the observation.'); }
    setStopResult(`Session ${session} closed by the native broker.${logErrors.length ? ` ${logErrors.join(' ')}` : ''}`);
  };
  const stop = async () => {
    if (!stopSession || busy) return;
    setBusy('stop'); setActionError(null); setStopConfirm(false);
    try { await observeStop(stopSession); await load(); }
    catch (failure) { setActionError(`Session stop failed: ${String((failure as Error).message || failure)}`); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!impact || busy) return;
    setBusy('remove'); setActionError(null);
    try {
      if (stopOnRemove) {
        if (!stopSession) throw new Error('The session is no longer verified as running. Refresh the preview or remove without Stop.');
        await observeStop(stopSession);
        setStopOnRemove(false);
      }
      await api.removeAgentWithImpact(agentId, impact.impactToken);
      await onChanged(); onClose();
    } catch (failure) {
      setActionError(`Removal did not complete: ${String((failure as Error).message || failure)}`);
      // Impact can change while Stop runs; obtain a fresh token before another confirmation.
      try { setImpact(await api.agentRemoveImpact(agentId)); } catch { setImpact(null); }
    } finally { setBusy(null); }
  };
  const loadOlder = async () => {
    if (olderBefore === null || olderBusy) return;
    setOlderBusy(true);
    try { const page = await api.agentLifecycle(agentId, olderBefore);
      setLifecycle(current => [...current, ...page.items.filter(item => !current.some(old => old.seq === item.seq))]);
      setOlderBefore(page.hasMore ? page.nextBefore : null);
    } catch (failure) { setActionError(String((failure as Error).message || failure)); }
    finally { setOlderBusy(false); }
  };

  return <Modal onClose={() => { if (!busy) onClose(); }}>
    <section className="sheet sheet-wide agent-panel" role="dialog" aria-modal="true" aria-label={agent ? `Agent ${agent.name}` : 'Agent panel'}>
      <header className="sheet-head"><div><h2>{agent ? agentLabel(agent) : 'Agent'}</h2>
        <p>{agent?.project ?? 'No project'} · {agent?.role ?? 'Loading'}{agent?.seniority ? ` · ${agent.seniority}` : ''}</p></div>
        <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose} disabled={Boolean(busy)}><X size={16} /></button></header>
      <div className="sheet-body">
        {loading && !overview && <p role="status">Loading agent…</p>}
        {error && <p className="err" role="alert">{error} <button type="button" onClick={() => void load()}>Retry</button></p>}
        {actionError && <p className="err" role="alert">{actionError}</p>}
        {stopResult && <p role="status">{stopResult}</p>}
        {overview && agent && <>
          <section aria-label="Agent status" className="agent-panel-section">
            <h3>Overview</h3>
            <p>{fixed ? 'Fixed agent' : 'Task-bound worker'} · {runtime?.statusLine ?? 'Status unknown'}
              {agent.activity?.hint ? ` · ${agent.activity.hint}` : ''}</p>
            <p>Session: {stopSession ? 'running' : runtime?.sessionState ?? 'unknown'}{stopSession || runtime?.sessionName ? ` · ${stopSession ?? runtime?.sessionName}` : ''}</p>
            {agent.activity && <p>Activity since <RelativeTime at={agent.activity.since} /></p>}
            {fixed ? <p>Software and model: unknown. Choose launch settings when you resume this agent.</p> :
              <p>{overview.profile.type === 'task_bound' && 'configurationSource' in overview.profile && overview.profile.configurationSource === 'current_template'
                ? 'Current template settings (the running process may differ)' : 'Template settings unavailable'} ·
                {' '}Template: {overview.profile.type === 'task_bound' ? overview.profile.label ?? overview.profile.templateId : 'unknown'} ·
                {' '}Software: {overview.profile.type === 'task_bound' ? overview.profile.software ?? 'unknown' : 'unknown'} ·
                {' '}Model: {overview.profile.type === 'task_bound' ? overview.profile.model ?? 'unknown' : 'unknown'} ·
                {' '}Effort: {overview.profile.type === 'task_bound' ? overview.profile.effort ?? 'unknown' : 'unknown'}</p>}
            <p>Inbox: {overview.inbox.queued.exact ? overview.inbox.queued.atLeast : `at least ${overview.inbox.queued.atLeast}`} queued ·
              {' '}{overview.inbox.awaitingReceipt} awaiting receipt · {overview.inbox.acknowledgedMessages} acknowledged</p>
            <p>{workerTrafficLabel(overview.traffic ?? undefined)}</p>
            {overview.work && <p>Work: {overview.work.assigned} assigned · {overview.work.delegated} delegated · {overview.work.toReview} to review</p>}
            {overview.currentTask && <div className="agent-panel-task"><TaskChip state={overview.currentTask.task.state} />
              <strong>{overview.currentTask.task.contract.objective}</strong>
              {overview.currentTask.task.checkpoint && <div><p>Checkpoint saved <RelativeTime at={overview.currentTask.task.checkpoint.savedAt} /></p>
                <p>Completed: {overview.currentTask.task.checkpoint.data.completedSteps.join('; ') || 'none reported'}</p>
                <p>Open questions: {overview.currentTask.task.checkpoint.data.unresolvedQuestions.join('; ') || 'none reported'}</p>
                <p>Next action: {overview.currentTask.task.checkpoint.data.nextAction}</p></div>}
              <button type="button" className="btn" onClick={() => onOpenTask(overview.currentTask!)}>Open task controls</button>
              <button type="button" className="btn" onClick={() => onOpenThread(overview.currentTask!)}>Open thread</button></div>}
          </section>
          <div className="agent-panel-actions">
            <button type="button" className="btn" disabled={!active} onClick={() => onMessage(agent)}>Message</button>
            {(stopSession || runtime?.sessionName && runtime.sessionState === 'reconnecting') &&
              <button type="button" className="btn" onClick={() => setTerminalSession(stopSession ?? runtime!.sessionName)}>Open terminal</button>}
            {active && agent.role === 'worker' && <button type="button" className="btn" onClick={() => onClear(agent)}>Clear context…</button>}
            {fixed && <button type="button" className="btn" disabled={!active || Boolean(stopSession) || runtime?.sessionState === 'running'}
              title={stopSession || runtime?.sessionState === 'running' ? 'A session is already running' : undefined}
              onClick={() => onResume(agent, overview.resumeAliases)}>Resume…</button>}
            {fixed && <button type="button" className="btn btn-danger" disabled={!active || !stopSession || Boolean(busy)}
              title={!stopSession ? 'A uniquely owned live session is required' : undefined}
              onClick={() => setStopConfirm(true)}>Stop session…</button>}
          </div>
          {stopConfirm && <div className="agent-panel-confirm" role="group" aria-label="Confirm session stop">
            <p>Stop {stopSession}? The native broker will end this session.</p>
            <button type="button" className="btn" onClick={() => setStopConfirm(false)}>Keep running</button>
            <button type="button" className="btn btn-danger" disabled={!stopSession || Boolean(busy)} onClick={() => void stop()}>Confirm Stop</button>
          </div>}
          {active && identity && <form className="agent-panel-section" onSubmit={event => void saveIdentity(event)}>
            <h3>Identity</h3>
            <label>Name<input value={identity.name} required maxLength={100} onChange={event => setIdentity({ ...identity, name: event.target.value })} /></label>
            <label>Focus<input value={identity.focus} maxLength={200} onChange={event => setIdentity({ ...identity, focus: event.target.value })} /></label>
            {agent.role === 'worker' && <label>Seniority<select value={identity.seniority} onChange={event => setIdentity({ ...identity, seniority: event.target.value as IdentityDraft['seniority'] })}>
              <option value="">Unspecified</option><option value="junior">Junior</option><option value="mid">Mid</option><option value="senior">Senior</option>
            </select></label>}
            {identityConflict && <p role="status">Current saved name: {agent.name}; focus: {agent.focus ?? 'none'}; seniority: {agent.seniority ?? 'none'}.</p>}
            <div className="agent-panel-actions"><button type="submit" className="btn" disabled={Boolean(busy) || identityConflict}>Save identity</button>
              <button type="button" className="btn" onClick={() => { setIdentity(identityDraft(agent)); identityBase.current = overview.identityRevision;
                setIdentityConflict(false); }}>Reload saved values</button></div>
          </form>}
          {active && agent.role === 'worker' && capability && <form className="agent-panel-section" onSubmit={event => void saveCapability(event)}>
            <h3>Capability card</h3>
            <p>Revision {overview.capability?.revision ?? 0}{overview.capability?.lastEditorId ? ` · last edited by ${overview.capability.lastEditorId}` : ''}</p>
            <label className="check"><input type="checkbox" checked={capability.enabled} onChange={event => setCapability({ ...capability, enabled: event.target.checked })} />Enabled for routing</label>
            <label>Capabilities (comma separated)<input value={capability.capabilities} onChange={event => setCapability({ ...capability, capabilities: event.target.value })} /></label>
            <fieldset className="checks"><legend>Modes</legend>{(['implementation', 'review', 'read_only'] as const).map(mode =>
              <label className="check" key={mode}><input type="checkbox" checked={capability.modes.includes(mode)} onChange={event => setCapability({ ...capability,
                modes: event.target.checked ? [...capability.modes, mode] : capability.modes.filter(value => value !== mode) })} />{mode.replace('_', ' ')}</label>)}</fieldset>
            <label>Model (optional)<input value={capability.model} onChange={event => setCapability({ ...capability, model: event.target.value })} /></label>
            <label>Host (optional)<input value={capability.host} onChange={event => setCapability({ ...capability, host: event.target.value })} /></label>
            <label>Available context (optional)<input type="number" min="1" max="10000000" value={capability.availableContext}
              onChange={event => setCapability({ ...capability, availableContext: event.target.value })} /></label>
            <label>Availability<select value={capability.availability} onChange={event => setCapability({ ...capability, availability: event.target.value as CapabilityCard['availability'] })}>
              <option value="available">Available</option><option value="busy">Busy</option><option value="unavailable">Unavailable</option></select></label>
            <label>Maximum in progress<input type="number" min="1" max="8" required value={capability.maxInProgress}
              onChange={event => setCapability({ ...capability, maxInProgress: event.target.value })} /></label>
            {capabilityConflict && <p role="status">The saved card is now revision {overview.capability?.revision ?? 0}. Reload before saving.</p>}
            <div className="agent-panel-actions"><button type="submit" className="btn" disabled={Boolean(busy) || capabilityConflict}>Save capability</button>
              <button type="button" className="btn" onClick={() => { setCapability(capabilityDraft(overview.capability?.card ?? null));
                capabilityBase.current = overview.capability?.revision ?? 0; setCapabilityConflict(false); }}>Reload saved card</button></div>
          </form>}
          <section className="agent-panel-section" aria-label="Lifecycle"><h3>Lifecycle</h3>
            {lifecycle.length === 0 && <p>No events recorded yet.</p>}
            <ol className="agent-panel-log">{lifecycle.map(event => <li key={event.seq}><strong>{event.summary}</strong>
              {' '}<small>{event.source === 'human_ui' ? 'Human UI observation' : 'Server'}
                {event.actorId ? ` · by ${agents.find(agent => agent.id === event.actorId)?.name ?? event.actorId}` : ''}
                {' '}· <RelativeTime at={event.at} /></small></li>)}</ol>
            {olderBefore !== null && <button type="button" className="btn" disabled={olderBusy} onClick={() => void loadOlder()}>{olderBusy ? 'Loading…' : 'Load older events'}</button>}
          </section>
          {active && <section className="agent-panel-section" aria-label="Remove agent"><h3>Remove agent</h3>
            {!impact ? <button type="button" className="btn btn-danger" disabled={impactLoading || Boolean(busy)} onClick={() => void requestImpact()}>
              {impactLoading ? 'Checking impact…' : 'Review removal impact…'}</button> : <div className="agent-panel-confirm">
              <p>Removing {impact.name} will cancel {impact.cancelled.count} tasks and leave {impact.unreviewed.count} tasks without a reviewer.</p>
              {impact.pendingLaunch && <p>A worker launch is still pending. Removal will cancel its launch request.</p>}
              {impact.pendingNativeCleanup && <p>A known native session has no confirmed close. Removal will queue or retain server-managed cleanup for this task-bound worker.</p>}
              {impact.launch && <p>Launch request {impact.launch.requestId}: {impact.launch.state}
                {impact.launch.session ? ` · session ${impact.launch.session}` : ''}
                {impact.launch.closeState ? ` · close ${impact.launch.closeState}` : ''}</p>}
              {impact.cancelled.taskIds.length > 0 && <p>Cancelled tasks: {impact.cancelled.taskIds.join(', ')}</p>}
              {impact.unreviewed.taskIds.length > 0 && <p>Tasks needing another reviewer: {impact.unreviewed.taskIds.join(', ')}</p>}
              <p>Messages and task history remain. The server will validate this impact again at removal.</p>
              {stopSession && <label className="check"><input type="checkbox" checked={stopOnRemove} onChange={event => setStopOnRemove(event.target.checked)} />
                Stop verified session {stopSession} before removal</label>}
              {impact.terminalSession && !stopSession && <p>Recorded session {impact.terminalSession} is not verified as running. It cannot be stopped from this panel.</p>}
              <div className="agent-panel-actions"><button type="button" className="btn" onClick={() => { setImpact(null); setStopOnRemove(false); }}>Cancel</button>
                <button type="button" className="btn btn-danger" disabled={Boolean(busy)} onClick={() => void remove()}>{busy === 'remove' ? 'Removing…' : 'Confirm removal'}</button></div>
            </div>}
          </section>}
        </>}
      </div>
      {terminalSession && <SessionsSheet agents={agents} projects={projects} project={agent?.project ?? null}
        initialSession={terminalSession} onClose={() => setTerminalSession(null)} />}
    </section>
  </Modal>;
}
