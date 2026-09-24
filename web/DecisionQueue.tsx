import { useEffect, useState } from 'react';
import type { DecisionPage, DecisionView } from '../src/shared/decisions.ts';
import { api } from './api.ts';

export function DecisionCard({ decision, onOpen, onAnswered }: {
  decision: DecisionView;
  onOpen?: () => void;
  onAnswered?: (decision: DecisionView) => void;
}) {
  const [draft, setDraft] = useState('');
  /** The option picked with one click, waiting for Confirm; a free-text answer stays available meanwhile. */
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerable = decision.state === 'awaiting_input' && Boolean(onAnswered);
  const recommended = decision.options.find(option => option.id === decision.recommendation?.optionId);
  const chosen = decision.options.find(option => option.id === choice);
  const answer = async (body: string, done: () => void) => {
    if (!body.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.answerDecision(decision.id, {
        requestId: crypto.randomUUID(), expectedRevision: decision.revision, body: body.trim(),
      });
      done(); onAnswered?.(result.decision);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  // The option id stays first so agents can match the answer to the option they offered.
  const confirm = () => chosen && void answer(`${chosen.id}: ${chosen.label}${note.trim() ? `\n\n${note.trim()}` : ''}`,
    () => { setChoice(null); setNote(''); });
  return <section className="decision-card" aria-label="Human decision request">
    <header>
      <div><strong>{decision.question}</strong><small>{decision.requesterName} · task revision {decision.taskRevision}</small></div>
      <span className={'decision-state decision-' + decision.state}>{decision.state.replaceAll('_', ' ')}</span>
    </header>
    <p>Affected: {decision.affectedWorkers.map(worker => worker.name).join(', ')}</p>
    {decision.options.length > 0 && <div className="decision-options">
      {decision.options.map(option => <button key={option.id} type="button"
        disabled={!answerable || busy} aria-pressed={choice === option.id}
        onClick={() => { setChoice(current => current === option.id ? null : option.id); setError(null); }}>
        <strong>{option.label}</strong>
        {option.id === recommended?.id && <span className="decision-tag">Recommended</span>}
        <small>{option.impact}</small>
      </button>)}
    </div>}
    {answerable && chosen && <div className="decision-confirm" role="group" aria-label="Confirm answer">
      <p>Answer <strong>{chosen.label}</strong>{chosen.id === recommended?.id ? ' (recommended)' : ''}</p>
      <input aria-label="Optional note" placeholder="Add a note (optional)" value={note} maxLength={2000}
        onChange={event => setNote(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') confirm(); }} />
      <div className="decision-confirm-actions">
        <button type="button" className="primary" disabled={busy} onClick={confirm}>{busy ? 'Sending…' : 'Confirm'}</button>
        <button type="button" className="text-btn" disabled={busy} onClick={() => { setChoice(null); setNote(''); }}>Cancel</button>
      </div>
    </div>}
    {decision.recommendation && <details open>
      <summary>Recommendation · advisory</summary>
      <p>{recommended ? `Recommended: ${recommended.label}. ` : ''}{decision.recommendation.rationale}</p>
      <small>Uncertainty: {decision.recommendation.uncertainty}</small>
    </details>}
    {(decision.evidenceSeqs.length > 0 || decision.artifacts.length > 0) && <details>
      <summary>Evidence and artifacts</summary>
      <p>Evidence seqs: {decision.evidenceSeqs.join(', ') || 'none'}</p>
      <p>Artifacts: {decision.artifacts.join('; ') || 'none'}</p>
    </details>}
    {decision.relatedDecisionIds.length > 0 && <p>Related decisions: {decision.relatedDecisionIds.join(', ')}</p>}
    {decision.requestedByAt && <p>Requested by: {new Date(decision.requestedByAt).toLocaleString()}</p>}
    {decision.answer && <div className="decision-answer">
      <strong>Human answer</strong><p>{decision.answer.body}</p>
      <small>{decision.answer.source} · {new Date(decision.answer.at).toLocaleString()}</small>
      {decision.delivery.length > 0 && <p>Delivery: {decision.delivery.map(item => item.name + ': ' + item.state).join(' · ')}</p>}
    </div>}
    {answerable && <div className="decision-reply">
      <textarea aria-label="Decision answer" value={draft} onChange={event => setDraft(event.target.value)}
        placeholder={decision.options.length > 0 ? 'Or answer in your own words.' : 'Answer in your own words.'} />
      <button type="button" className="primary" disabled={busy || !draft.trim()} onClick={() => void answer(draft, () => setDraft(''))}>
        {busy && !chosen ? 'Sending…' : 'Answer'}
      </button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {decision.state !== 'awaiting_input' && <p className="decision-warning">{decision.warning}</p>}
    {onOpen && <button type="button" className="text-btn" onClick={onOpen}>Open decision thread</button>}
  </section>;
}

export function DecisionQueue({ project, tick, onOpen }: {
  project: string;
  tick: number;
  onOpen: (decision: DecisionView) => void;
}) {
  const [page, setPage] = useState<DecisionPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api.decisions(project, true, controller.signal).then(setPage).catch(reason => {
      if ((reason as Error)?.name !== 'AbortError') setError(String(reason));
    });
    return () => controller.abort();
  }, [project, tick]);
  return <>
    <header className="desk-h"><div><h1>Decisions</h1>
      <p>{page ? String(page.awaiting) + ' awaiting Human input. ' : ''}Task-bound questions stay revision-fenced; expiry never applies a recommendation.</p>
    </div></header>
    <div className="stream decision-queue">
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p className="empty">Loading decisions…</p>}
      {page?.items.length === 0 && <p className="empty">No decision requests in this project.</p>}
      {page?.items.map(decision => <DecisionCard key={decision.id} decision={decision}
        onOpen={() => onOpen(decision)}
        onAnswered={updated => setPage(current => current ? {
          ...current,
          items: current.items.map(item => item.id === updated.id ? updated : item),
          awaiting: current.items.filter(item => item.id !== updated.id && item.state === 'awaiting_input').length,
        } : current)} />)}
    </div>
  </>;
}
