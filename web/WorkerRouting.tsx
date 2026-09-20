import { useEffect, useRef, useState } from 'react';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import type { RoutingSuggestions } from '../src/shared/routing.ts';
import { api } from './api.ts';

/** Explicit requests only: opening a task never assigns work or fetches hidden rankings. */
export function WorkerRouting({ task }: { task: TaskSnapshot }) {
  const [capabilities, setCapabilities] = useState(''), [category, setCategory] = useState('general');
  const [mode, setMode] = useState<'implementation' | 'review' | 'read_only'>('implementation');
  const [result, setResult] = useState<RoutingSuggestions | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [workerId, setWorkerId] = useState(''), [reason, setReason] = useState('');
  const [saved, setSaved] = useState(false), active = useRef<AbortController | null>(null);
  const operation = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => {
    active.current?.abort(); active.current = null; setResult(null); setWorkerId(''); setError(''); setBusy(false); setSaved(false); operation.current = null;
    return () => { active.current?.abort(); active.current = null; };
  }, [task.id, task.revision]);
  const suggest = async (offset = 0) => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setSaved(false);
    try {
      const value = await api.suggestWorkers(task.id, { requiredCapabilities: capabilities.split(',').map(t => t.trim()).filter(Boolean), mode, category, offset }, controller.signal);
      if (active.current === controller && !controller.signal.aborted) { setResult(value); setWorkerId(''); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Routing request failed'); }
    finally { if (active.current === controller) setBusy(false); }
  };
  const record = async () => {
    const payload = JSON.stringify([task.id, task.revision, workerId, reason]);
    if (operation.current?.payload !== payload) operation.current = { payload, id: crypto.randomUUID() };
    active.current?.abort(); const controller = new AbortController(); active.current = controller; setBusy(true); setError('');
    try {
      await api.recordRoutingChoice(task.id, { expectedRevision: task.revision, workerId, reason, requestId: operation.current.id }, controller.signal);
      if (active.current === controller && !controller.signal.aborted) setSaved(true);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Choice could not be recorded'); }
    finally { if (active.current === controller) setBusy(false); }
  };
  return <details className="worker-routing"><summary>Advisory worker routing</summary>
    <p>Worker declarations and limited review evidence, not a verified capability score. This never assigns work or changes a model.</p>
    <label>Required capabilities (comma-separated)<input value={capabilities} disabled={busy} onChange={e => { setCapabilities(e.target.value); setResult(null); }} /></label>
    <label>Task category<input value={category} disabled={busy} onChange={e => { setCategory(e.target.value); setResult(null); }} /></label>
    <label>Mode<select value={mode} disabled={busy} onChange={e => { setMode(e.target.value as typeof mode); setResult(null); }}>
      <option value="implementation">Implementation</option><option value="review">Separate review</option><option value="read_only">Read only</option>
    </select></label>
    <button type="button" disabled={busy} onClick={() => void suggest()}>Find eligible workers</button>
    {error && <p role="alert">{error}</p>}
    {result && <><p>{result.eligibleTotal} eligible opted-in workers; task revision {result.taskRevision}. Provider cost: unknown.</p>
      {result.candidates.map(candidate => <section key={candidate.workerId} aria-label={`Suggestion ${candidate.name}`}>
        <strong>{candidate.name}</strong><p>{candidate.card.model ?? 'Unknown model'} / {candidate.card.host ?? 'Unknown host'} · declaration revision {candidate.capabilityRevision}</p>
        {candidate.reasons.map(text => <p key={text}>{text}</p>)}
        <p>{candidate.evidence.interval95 ? `Descriptive accepted-rate interval: ${(100 * candidate.evidence.interval95[0]).toFixed(0)}–${(100 * candidate.evidence.interval95[1]).toFixed(0)}%` : 'No matching reviewed outcomes.'}</p>
        <button type="button" disabled={busy} onClick={() => { setWorkerId(candidate.workerId); setSaved(false); }}>Record preference for {candidate.name}</button>
      </section>)}
      {result.nextOffset !== null && <button type="button" disabled={busy} onClick={() => void suggest(result.nextOffset!)}>Next candidates</button>}
      <p>{result.warning}</p><p>{result.delegationAdvice}</p>
      {workerId && <><label>Reason (recorded in task history)<textarea value={reason} maxLength={700} disabled={busy} onChange={e => { setReason(e.target.value); setSaved(false); }} /></label>
        <button type="button" disabled={busy || !reason.trim() || saved} onClick={() => void record()}>Record choice without assigning</button></>}
    </>}
    {saved && <p role="status">Choice recorded. Task ownership and running agents are unchanged.</p>}
  </details>;
}
