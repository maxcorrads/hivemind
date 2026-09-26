import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, Channel } from '../src/shared/types.ts';
import type { Room, RoomContract, RoomView } from '../src/shared/rooms.ts';
import { api, ApiError } from './api.ts';
import { Disclosure } from './Disclosure.tsx';
import { loadLatestRoomView } from './room-state.ts';

export function RoomDetails({ view }: { view: RoomView }) {
  const room = view.room;
  if (!room) return null;
  return <>
    <p className="room-summary"><strong>{room.contract.mode === 'finite' ? 'Task-scoped room' : 'Ongoing channel'} · {room.state}</strong> · revision {room.revision} / contract {room.contractVersion}</p>
    <p className="room-meta">Coordinating brain: {room.contract.coordinator}</p>
    <p className="room-purpose">{room.contract.purpose}</p>
    <h4>Operating rules</h4><ul>{room.contract.rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
    {room.contract.limits.length > 0 && <><h4>Limits</h4><ul>{room.contract.limits.map((r, i) => <li key={i}>{r}</li>)}</ul></>}
    <details><Disclosure>Participants, completion and task state</Disclosure>
      <ul>{room.contract.participants.map(p => <li key={p.name}>{p.name}: {p.boundary}</li>)}</ul>
      <p>Completion: {room.contract.completion.join('; ')}</p>
      {room.contract.originTaskId && <p>Originating task: {room.contract.originTaskId}</p>}
      <ul>{view.tasks.map(t => <li key={t.id}><a href={`#/c/${encodeURIComponent(room.channelId)}/t/${encodeURIComponent(t.id)}`}>{t.worker} · {t.id.slice(0, 8)}</a>: {t.state} · {t.room.status} · rules {t.room.acknowledged ? 'acknowledged' : 'not yet acknowledged'}</li>)}</ul>
      {view.tasksHasMore && <p>Showing up to 100 tasks. Older tasks remain in channel history; agents can page with get_room beforeTask.</p>}
    </details>
    {(view.links.length > 0 || view.unmanagedBots.length > 0) && <details open={room.state === 'archived'}><Disclosure>Source suspension reports</Disclosure>
      <p>These are plugin reports, not independent verification. Pending or unsupported does not mean stopped.</p>
      <ul>{view.links.map(l => <li key={`${l.botId}:${l.id}`}>{l.label}: requested {l.desired}, reported {l.observed} (generation {l.generation}){l.detail && ` · ${l.detail}`}</li>)}</ul>
      {view.unmanagedBots.length > 0 && <p role="status">No lifecycle registration: {view.unmanagedBots.join(', ')}. Suspend these integrations explicitly; Hivemind cannot confirm they stopped.</p>}
    </details>}
  </>;
}
export function RoomPanel({ channel, agents, tick }: { channel: Channel; agents: Agent[]; tick: number }) {
  const [view, setView] = useState<RoomView | null>(null), [error, setError] = useState('');
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState<RoomContract | null>(null);
  const [base, setBase] = useState(0), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [archiving, setArchiving] = useState(false);
  const [running, setRunning] = useState(''), [resumeSources, setResumeSources] = useState(false);
  const [history, setHistory] = useState<Room[]>([]);
  const [pending, setPending] = useState<{ requestId: string; expectedRevision: number; action: unknown } | null>(null);
  const request = useRef(0), mounted = useRef(true), inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  const refresh = useCallback(() => loadLatestRoomView(request, () => api.room(channel.id), setView,
    e => setError((e as Error).message)), [channel.id]);
  useEffect(() => { void refresh(); }, [refresh, tick]);
  const room = view?.room;
  const workers = agents.filter(a => a.role === 'worker' && channel.memberIds.includes(a.id));
  const brains = agents.filter(a => a.role === 'brain' && channel.memberIds.includes(a.id));
  const hasRunning = (view?.activeTaskCount ?? 0) > 0;
  const begin = () => {
    setBase(room?.revision ?? 0); setReason(''); setError('');
    setDraft(room?.contract ?? { mode: 'ongoing', purpose: '', rules: [], limits: [], coordinator: brains[0]?.name ?? '',
      participants: [], completion: ['Human archives when this activity is no longer needed.'], originTaskId: null });
    setEditing(true);
  };
  const submit = async (action: unknown, expectedRevision: number) => {
    if (inFlight.current) return;
    const operation = pending ?? { requestId: crypto.randomUUID(), expectedRevision, action: structuredClone(action) };
    inFlight.current = true; setPending(operation);
    setBusy(true); setError(''); ++request.current;
    try {
      await api.roomEvent(channel.id, operation);
      if (!mounted.current) return;
      setPending(null);
      setEditing(false); setArchiving(false); setReason('');
      // A delayed POST snapshot can predate live updates already displayed. Read
      // after the commit instead; task/source changes need not bump room.revision.
      await refresh();
    } catch (e) {
      if (mounted.current) {
        // Network/JSON failures and 5xx can occur after commit. Only explicit
        // rejection responses let us discard the original idempotency key.
        const rejected = e instanceof ApiError && [400, 401, 403, 404, 409, 413, 422].includes(e.status);
        if (rejected) setPending(null);
        setError(`${rejected ? 'Request rejected; draft retained.' : 'Save outcome is unknown; it may already be committed.'} ${(e as Error).message}`);
      }
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const reconcile = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    const id = ++request.current;
    try {
      const latest = await api.room(channel.id);
      if (!mounted.current || id !== request.current) return;
      setView(latest); setBase(latest.room?.revision ?? 0); setPending(null);
      setError('Latest state loaded. Compare the saved contract with your retained draft before submitting a new operation.');
    } catch (e) { if (mounted.current && id === request.current) setError((e as Error).message); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const lines = (v: string) => v.split('\n');
  return <section className="room-panel" aria-label="Channel contract">
    <div className="room-panel-heading"><strong>Channel contract</strong>
      {!editing && room?.state !== 'archived' && <button type="button" className="btn" disabled={!view || busy || !!pending} onClick={begin}>{room ? 'Edit contract' : 'Set up contract'}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {pending && !busy && <p role="status">The save outcome is unknown. Retry the exact request, or inspect the latest state before changing it. Leaving this channel discards the local retry; check history before resubmitting after returning.</p>}
    {pending && <button type="button" className="btn" disabled={busy} onClick={() => void submit(pending.action, pending.expectedRevision)}>Retry exact request</button>}
    {(pending || error) && <button type="button" className="btn" disabled={busy} onClick={() => void reconcile()}>Reconcile with latest state</button>}
    {view && <RoomDetails view={view} />}
    {!room && !editing && <p>No persistent contract. Ordinary channel behavior is unchanged.</p>}
    {editing && draft && <form onSubmit={e => { e.preventDefault(); void submit({ type: 'configure', contract: {
      ...draft, rules: draft.rules.filter(Boolean), limits: draft.limits.filter(Boolean), completion: draft.completion.filter(Boolean) }, reason }, base); }}>
      <fieldset disabled={busy || !!pending}>
      <label>Mode<select value={draft.mode} disabled={Boolean(room)} onChange={e => setDraft({ ...draft, mode: e.target.value as RoomContract['mode'] })}><option value="ongoing">Ongoing activity</option><option value="finite" disabled={channel.type !== 'private'}>Finite collaboration (private channel)</option></select></label>
      <label>Purpose<textarea required maxLength={700} value={draft.purpose} onChange={e => setDraft({ ...draft, purpose: e.target.value })} /></label>
      <label>Operating rules (one per line)<textarea required value={draft.rules.join('\n')} onChange={e => setDraft({ ...draft, rules: lines(e.target.value) })} /></label>
      <label>Limits (one per line)<textarea value={draft.limits.join('\n')} onChange={e => setDraft({ ...draft, limits: lines(e.target.value) })} /></label>
      <label>Coordinating brain<select required value={draft.coordinator} onChange={e => setDraft({ ...draft, coordinator: e.target.value })}><option value="">Select an invited brain</option>{brains.map(a => <option key={a.id}>{a.name}</option>)}</select></label>
      <fieldset><legend>Invited workers and ownership boundaries</legend>{workers.map(w => {
        const p = draft.participants.find(p => p.name === w.name);
        return <div key={w.id} className="room-participant"><label className="check"><input type="checkbox" checked={Boolean(p)} onChange={e => setDraft({ ...draft, participants: e.target.checked ? [...draft.participants, { name: w.name, boundary: '' }] : draft.participants.filter(p => p.name !== w.name) })} />{w.name}</label>
          {p && <label>Boundary for {w.name}<input required maxLength={700} value={p.boundary} onChange={e => setDraft({ ...draft, participants: draft.participants.map(p => p.name === w.name ? { ...p, boundary: e.target.value } : p) })} /></label>}</div>;
      })}</fieldset>
      {draft.mode === 'finite' && <label>Originating task ID<input required disabled={Boolean(room)} value={draft.originTaskId ?? ''} onChange={e => setDraft({ ...draft, originTaskId: e.target.value || null })} /></label>}
      <label>Completion policy (one criterion per line)<textarea required value={draft.completion.join('\n')} onChange={e => setDraft({ ...draft, completion: lines(e.target.value) })} /></label>
      <label>Reason for this change<input required maxLength={700} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <p>Human is changing these rules. Existing tasks will require reconciliation with the new version.</p>
      <div className="room-actions">
        <button className="btn btn-primary" disabled={busy} type="submit">Save contract</button>
        <button className="btn btn-ghost" disabled={busy} type="button" onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
      </div>
      </fieldset>
    </form>}
    {room && !editing && <div className="room-controls">
      {room.state === 'active' && !archiving && <button className="btn" disabled={busy || !!pending} onClick={() => { setBase(room.revision); setReason(''); setError(''); setRunning(''); setArchiving(true); }}>Archive channel…</button>}
      {archiving && <form onSubmit={e => { e.preventDefault(); void submit({ type: 'archive', reason, ...(hasRunning ? { running } : {}) }, base); }}>
        <fieldset disabled={busy || !!pending}>
        <p>Prevent new work and request suspension of source links for this channel only. History is retained.</p>
        {hasRunning && <label>Running tasks<select required value={running} onChange={e => setRunning(e.target.value)}><option value="">Choose explicitly</option><option value="finish">Let existing tasks finish</option><option value="stop">Request interruption (not completion)</option></select></label>}
        <label>Reason<input required maxLength={700} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <div className="room-actions">
          <button className="btn btn-primary" disabled={busy} type="submit">Confirm archive</button>
          <button className="btn btn-ghost" disabled={busy} type="button" onClick={() => setArchiving(false)}>Cancel</button>
        </div>
        </fieldset>
      </form>}
      {room.state === 'archived' && <form onSubmit={e => { e.preventDefault(); void submit({ type: 'reopen', reason, resumeSources }, room.revision); }}>
        <fieldset disabled={busy || !!pending}>
        <label>Reason to reopen<input required maxLength={700} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={resumeSources} onChange={e => setResumeSources(e.target.checked)} />Request resumption of registered source links</label>
        <p>Stopped tasks stay stopped. Old observations are not automatically replayed.</p>
        <div className="room-actions"><button className="btn btn-primary" disabled={busy} type="submit">Reopen channel</button></div>
        </fieldset>
      </form>}
      <button className="btn btn-ghost" disabled={busy} type="button" onClick={() => api.roomHistory(channel.id).then(r => { if (mounted.current) setHistory(r.history); }).catch(e => setError(e.message))}>Show recent contract history</button>
      {history.length > 0 && <details open className="room-history"><Disclosure>Latest {history.length} revisions</Disclosure>{history.map(r => <div key={r.revision} className="room-revision"><strong>Revision {r.revision}, contract {r.contractVersion} · {r.state}</strong><p>{r.contract.purpose}</p><p>{r.contract.rules.join('; ')}</p><p>{r.changedBy?.name} ({r.changedBy?.role}): {r.changedBy?.reason}</p><p>Human instruction: {r.humanInstructionSeq ?? 'direct Human configuration'}</p></div>)}</details>}
    </div>}
  </section>;
}
