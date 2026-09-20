import { useEffect, useState } from 'react';
import type { DecisionPage, DecisionView } from '../src/shared/decisions.ts';
import { api } from './api.ts';

export function DecisionCard({ decision, onOpen, onAnswered }: {
  decision: DecisionView;
  onOpen?: () => void;
  onAnswered?: (decision: DecisionView) => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.answerDecision(decision.id, {
        requestId: crypto.randomUUID(), expectedRevision: decision.revision, body: draft.trim(),
      });
      setDraft(''); onAnswered?.(result.decision);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <section className="decision-card" aria-label="Human decision request">
    <header>
      <div><strong>{decision.question}</strong><small>{decision.requesterName} · task revision {decision.taskRevision}</small></div>
      <span className={'decision-state decision-' + decision.state}>{decision.state.replaceAll('_', ' ')}</span>
    </header>
    <p>Affected: {decision.affectedWorkers.map(worker => worker.name).join(', ')}</p>
    {decision.options.length > 0 && <div className="decision-options">
      {decision.options.map(option => <button key={option.id} type="button"
        disabled={decision.state !== 'awaiting_input'}
        onClick={() => setDraft(option.id + ': ' + option.label)}>
        <strong>{option.label}</strong><small>{option.impact}</small>
      </button>)}
    </div>}
    {decision.recommendation && <details open>
      <summary>Recommendation · advisory</summary>
      <p>{decision.recommendation.optionId ? 'Option ' + decision.recommendation.optionId + ': ' : ''}{decision.recommendation.rationale}</p>
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
    {decision.state === 'awaiting_input' && onAnswered && <div className="decision-reply">
      <textarea aria-label="Decision answer" value={draft} onChange={event => setDraft(event.target.value)}
        placeholder="Answer in free text or choose an option above." />
      <button type="button" className="primary" disabled={busy || !draft.trim()} onClick={() => void answer()}>
        {busy ? 'Sending…' : 'Answer'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>}
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
