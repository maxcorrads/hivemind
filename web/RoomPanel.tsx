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
    <p className="room-summary"><strong>{room.state === 'archived' ? 'Archived' : 'Active'}</strong> · revision {room.revision} / contract {room.contractVersion}</p>
    <p className="room-meta">Coordinating brain: {room.contract.coordinator}
      {room.contract.participants.length > 0 && <> · Workers: {room.contract.participants.join(', ')}</>}</p>
    <p className="room-purpose">{room.contract.instructions}</p>
    <details><Disclosure>Task state</Disclosure>
      <ul>{view.tasks.map(t => <li key={t.id}><a href={`#/c/${encodeURIComponent(room.channelId)}/t/${encodeURIComponent(t.id)}`}>{t.worker} · {t.id.slice(0, 8)}</a>: {t.state} · {t.room.status} · rules {t.room.acknowledged ? 'acknowledged' : 'not yet acknowledged'}</li>)}</ul>
      {view.tasksHasMore && <p>Showing up to 100 tasks. Older tasks remain in channel history; agents can page with get_room beforeTask.</p>}
    </details>
    {(view.links.length > 0 || view.unmanagedBots.length > 0) && <details open={room.state === 'archived'}><Disclosure>Source suspension reports</Disclosure>
      <p>These are bot reports, not independent verification. Pending or unsupported does not mean stopped.</p>
      <ul>{view.links.map(l => <li key={`${l.botId}:${l.id}`}>{l.label}: requested {l.desired}, reported {l.observed} (generation {l.generation}){l.detail && ` · ${l.detail}`}</li>)}</ul>
      {view.unmanagedBots.length > 0 && <p role="status">No lifecycle registration: {view.unmanagedBots.join(', ')}. Suspend these integrations explicitly; Hivemind cannot confirm they stopped.</p>}
    </details>}
  </>;
}
export function RoomPanel({ channel, archived = false, agents, tick }: { channel: Channel; archived?: boolean; agents: Agent[]; tick: number }) {
  const [view, setView] = useState<RoomView | null>(null), [error, setError] = useState('');
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState<RoomContract | null>(null);
  const [base, setBase] = useState(0);
  const [busy, setBusy] = useState(false);
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
  const begin = () => {
    setBase(room?.revision ?? 0); setError('');
    setDraft(room?.contract ?? { instructions: '', coordinator: brains[0]?.name ?? '', participants: [] });
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
      setEditing(false);
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
  return <section className="room-panel" aria-label="Channel contract">
    <div className="room-panel-heading"><strong>Channel contract</strong>
      {!editing && !archived && <button type="button" className="btn" disabled={!view || busy || !!pending} onClick={begin}>{room ? 'Edit contract' : 'Set up contract'}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {pending && !busy && <p role="status">The save outcome is unknown. Retry the exact request, or inspect the latest state before changing it. Leaving this channel discards the local retry; check history before resubmitting after returning.</p>}
    {pending && <button type="button" className="btn" disabled={busy} onClick={() => void submit(pending.action, pending.expectedRevision)}>Retry exact request</button>}
    {(pending || error) && <button type="button" className="btn" disabled={busy} onClick={() => void reconcile()}>Reconcile with latest state</button>}
    {view && <RoomDetails view={view} />}
    {!room && !editing && <p>No persistent contract. Ordinary channel behavior is unchanged.</p>}
    {editing && draft && <form onSubmit={e => { e.preventDefault(); void submit({ type: 'configure', contract: draft }, base); }}>
      <fieldset disabled={busy || !!pending}>
      <label>Instructions<textarea required maxLength={4000} rows={8} value={draft.instructions}
        placeholder="What this channel is for, how agents should work here, and when it is done."
        onChange={e => setDraft({ ...draft, instructions: e.target.value })} /></label>
      <label>Coordinating brain<select required value={draft.coordinator} onChange={e => setDraft({ ...draft, coordinator: e.target.value })}><option value="">Select an invited brain</option>{brains.map(a => <option key={a.id}>{a.name}</option>)}</select></label>
      {workers.length > 0 && <fieldset><legend>Workers who take tasks here</legend>{workers.map(w =>
        <label key={w.id} className="check"><input type="checkbox" checked={draft.participants.includes(w.name)} onChange={e => setDraft({ ...draft,
          participants: e.target.checked ? [...draft.participants, w.name] : draft.participants.filter(name => name !== w.name) })} />{w.name}</label>)}</fieldset>}
      <div className="room-actions">
        <button className="btn btn-primary" disabled={busy} type="submit">Save contract</button>
        <button className="btn btn-ghost" disabled={busy} type="button" onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
      </div>
      </fieldset>
    </form>}
    {room && !editing && <div className="room-controls">
      <button className="btn btn-ghost" disabled={busy} type="button" onClick={() => api.roomHistory(channel.id).then(r => { if (mounted.current) setHistory(r.history); }).catch(e => setError(e.message))}>Show recent contract history</button>
      {history.length > 0 && <details open className="room-history"><Disclosure>Latest {history.length} revisions</Disclosure>{history.map(r => <div key={r.revision} className="room-revision"><strong>Revision {r.revision}, contract {r.contractVersion} · {r.state}</strong><p>{r.contract.instructions}</p><p>{r.changedBy?.name} ({r.changedBy?.role}): {r.changedBy?.reason}</p><p>Human instruction: {r.humanInstructionSeq ?? 'direct Human configuration'}</p></div>)}</details>}
    </div>}
  </section>;
}
