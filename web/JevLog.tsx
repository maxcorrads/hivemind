import { useEffect, useRef, useState } from 'react';
import type { JevCall, JevCallLogView, JevCallSummary, JevRequestGroup } from '../src/shared/jev-calls.ts';
import { api } from './api.ts';
import { topologyLabel } from './AdaptiveRoutingPanel.tsx';
import { CollectorHealthNotice } from './EvidenceHealth.tsx';
import type { EvidenceCollectorHealth } from '../src/shared/evidence-health.ts';
import { answerLabel, appendOlderPage, contextRows, mergeRefreshedPage, outcomeLabel, percent, questionRows, reasonLabel, requestedModel, triggerLabel, workersLabel } from './jev-log-view.ts';

type Props = {
  project: string;
  /** Incremented on every realtime Jev call so the history refreshes. */
  tick: number;
  channelLabel: (channelId: string) => string;
  agentName: (agentId: string) => string;
  onOpenChannel: (channelId: string) => void;
};

const time = (at: number) => new Date(at).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' });

/** Routing log: Human-only history of every exchange with Jev, grouped by the request that caused it. */
export function JevLog({ project, tick, channelLabel, agentName, onOpenChannel }: Props) {
  const [view, setView] = useState<JevCallLogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [collector, setCollector] = useState<EvidenceCollectorHealth | null>(null);
  const detail = useRef<HTMLDivElement>(null);
  // On narrow screens the detail sits below the list: bring it into view when a call is chosen.
  useEffect(() => {
    if (selected && window.matchMedia?.('(max-width: 900px)').matches) detail.current?.scrollIntoView({ block: 'start' });
  }, [selected]);
  useEffect(() => { setView(null); setSelected(null); }, [project]);
  useEffect(() => {
    const controller = new AbortController();
    api.jevCalls(project, undefined, controller.signal).then(next => {
      setView(current => mergeRefreshedPage(current, next));
      setError(null);
    }).catch(reason => { if ((reason as Error)?.name !== 'AbortError') setError(String((reason as Error)?.message ?? reason)); });
    // Collector health is diagnostic only; failing to read it never hides the history.
    api.evidenceHealth(controller.signal).then(setCollector).catch(() => {});
    return () => controller.abort();
  }, [project, tick]);
  const older = () => {
    const cursor = view?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    api.jevCalls(project, cursor).then(next => setView(current => appendOlderPage(current, next)))
      .catch(reason => setError(String((reason as Error)?.message ?? reason)))
      .finally(() => setLoadingMore(false));
  };
  const calls = view?.requests.reduce((total, group) => total + group.callCount, 0) ?? 0;
  return <>
    <header className="desk-h"><div><h1>Routing log</h1>
      <p className="desk-sub">Every request Hivemind sent to Jev (TypeSafe) and its answer.</p>
      <p>Grouped by your request. {view ? `${view.requests.length} request${view.requests.length === 1 ? '' : 's'} · ${calls} call${calls === 1 ? '' : 's'} shown.` : ''} Only you can see this history; it stays on this machine.</p>
    </div></header>
    <div className="jev-log">
      <div className="jev-requests" aria-label="Routing log requests">
        <CollectorHealthNotice health={collector} />
        {error && <p className="err" role="alert">{error}</p>}
        {!view && !error && <p className="empty">Loading the routing log…</p>}
        {view?.requests.length === 0 && <p className="empty">Nothing in the routing log yet for this project. Enable Jev in Adaptive routing and write to a brain.</p>}
        {view?.requests.map(group => <RequestCard key={group.executionId} group={group} selected={selected}
          channelLabel={channelLabel} agentName={agentName} onSelect={setSelected} onOpenChannel={onOpenChannel} />)}
        {view?.hasMore && view.nextCursor && <button type="button" className="text-btn" disabled={loadingMore} onClick={older}>
          {loadingMore ? 'Loading…' : 'Older requests'}</button>}
      </div>
      <div className="jev-detail" ref={detail}>
        {selected ? <CallDetail key={selected} project={project} id={selected} channelLabel={channelLabel} agentName={agentName} />
          : <p className="empty">Select a call to see exactly what was sent to Jev and what it answered.</p>}
      </div>
    </div>
  </>;
}

function RequestCard({ group, selected, channelLabel, agentName, onSelect, onOpenChannel }: {
  group: JevRequestGroup; selected: string | null; channelLabel: (id: string) => string; agentName: (id: string) => string;
  onSelect: (id: string) => void; onOpenChannel: (channelId: string) => void;
}) {
  const last = group.calls.at(-1);
  return <section className="jev-request">
    <header>
      <p className="jev-request-text">{group.request || 'Request text unavailable'}</p>
      <small>
        <button type="button" className="text-btn" onClick={() => onOpenChannel(group.channelId)}>{channelLabel(group.channelId)}</button>
        {' · '}{group.brainId ? agentName(group.brainId) : 'no owning brain'}{' · '}{time(group.firstAt)}
      </small>
      {last && <span className={`jev-badge ${outcomeLabel(last).tone}`}>{badgeLabel(last)}</span>}
    </header>
    <ol className="jev-calls" aria-label={`${group.callCount} Jev calls`}>
      {group.calls.map(call => <CallRow key={call.id} call={call} active={call.id === selected} onSelect={() => onSelect(call.id)} />)}
    </ol>
  </section>;
}

/** The request's current state at a glance: the applied mode, or what happened to the last call. */
function badgeLabel(call: JevCallSummary): string {
  if (call.phase === 'observation') return 'Observed';
  if (call.outcome) return topologyLabel(call.outcome.appliedTopology);
  return call.status === 'unavailable' ? 'Jev unavailable' : 'Not applied';
}

function CallRow({ call, active, onSelect }: { call: JevCallSummary; active: boolean; onSelect: () => void }) {
  const outcome = outcomeLabel(call);
  return <li>
    <button type="button" className={`jev-call ${active ? 'active' : ''}`} aria-pressed={active} onClick={onSelect}>
      <span className="jev-call-trigger">{triggerLabel(call.trigger, call.phase)}</span>
      <span className={`jev-call-answer ${call.status}`}>Jev: {answerLabel(call)}</span>
      <span className={`jev-call-outcome ${outcome.tone}`}>{outcome.text}</span>
      <time>{new Date(call.createdAt).toLocaleTimeString()}</time>
    </button>
  </li>;
}

function CallDetail({ project, id, channelLabel, agentName }: { project: string; id: string;
  channelLabel: (id: string) => string; agentName: (id: string) => string }) {
  const [call, setCall] = useState<JevCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.jevCall(project, id, controller.signal).then(result => setCall(result.call))
      .catch(reason => { if ((reason as Error)?.name !== 'AbortError') setError(String((reason as Error)?.message ?? reason)); });
    return () => controller.abort();
  }, [project, id]);
  if (error) return <p className="err" role="alert">{error}</p>;
  if (!call) return <p className="empty">Loading call…</p>;
  const outcome = outcomeLabel(call);
  const request = (call.sent as { state?: { request?: string } } | null)?.state?.request ?? call.request;
  return <article className="jev-call-detail" aria-label="Jev call detail">
    <header>
      <h2>{triggerLabel(call.trigger, call.phase)}</h2>
      <small>{time(call.createdAt)} · {channelLabel(call.channelId)} · {call.brainId ? agentName(call.brainId) : 'no owning brain'}</small>
    </header>

    <section>
      <h3>1 · Sent to Jev</h3>
      <blockquote className="jev-request-full">{request || 'Request text unavailable'}</blockquote>
      <dl className="jev-context">
        {contextRows(call.sent).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
    </section>

    <section>
      <h3>2 · Jev's answers</h3>
      {call.status === 'unavailable' ? <p className="routing-warning">No answer: {call.error ?? 'Jev unavailable'}. Hivemind kept the current mode.</p>
        : <table className="jev-answers">
          <thead><tr><th>Question</th><th>Answer</th><th>Confidence</th></tr></thead>
          <tbody>{questionRows(call.sent, call.received).map(row => <tr key={row.id}>
            <td>{row.question}</td>
            <td>
              <strong>{row.answer}</strong>
              {row.score !== null && <span className="jev-meter" aria-hidden="true"><span style={{ width: `${Math.round(row.score * 100)}%` }} /></span>}
              {row.options.length > 1 && <details><summary>Probabilities</summary><ul className="jev-probabilities">
                {row.options.map(option => <li key={option.label} className={option.chosen ? 'chosen' : ''}>
                  <span>{option.label}</span><span className="jev-meter"><span style={{ width: `${Math.round(option.probability * 100)}%` }} /></span>
                  <span>{percent(option.probability)}</span></li>)}
              </ul></details>}
            </td>
            <td>{percent(row.confidence)}</td>
          </tr>)}</tbody>
        </table>}
    </section>

    <section>
      <h3>3 · Decision and result</h3>
      <dl className="jev-context">
        <div><dt>Jev recommends</dt><dd>{call.status === 'ok' ? `${topologyLabel(call.targetTopology)}${call.targetWorkers ? ` · ${workersLabel(call.targetWorkers)}` : ''}` : '—'}</dd></div>
        <div><dt>Overall confidence</dt><dd>{percent(call.confidence)} <small>(lowest answer confidence)</small></dd></div>
        <div><dt>Reason</dt><dd>{reasonLabel(call.reason)}</dd></div>
        <div><dt>What Hivemind did</dt><dd className={`jev-outcome ${outcome.tone}`}>{outcome.text}</dd></div>
        <div><dt>Requested model</dt><dd>{requestedModel(call) ?? '—'}</dd></div>
        <div><dt>Resolved model · time · tokens</dt><dd>{call.model ?? '—'}{call.model && requestedModel(call) && call.model !== requestedModel(call)
          ? <small> (differs from requested)</small> : null} · {call.latencyMs} ms · {call.inputTokens ?? '—'} in / {call.outputTokens ?? '—'} out</dd></div>
      </dl>
    </section>

    <section>
      <h3>Raw JSON</h3>
      <details><summary>Sent to TypeSafe</summary><pre>{call.sent ? JSON.stringify(call.sent, null, 2) : 'Nothing was sent.'}</pre></details>
      <details><summary>Received from TypeSafe</summary><pre>{call.received ? JSON.stringify(call.received, null, 2) : 'Nothing was received.'}</pre></details>
    </section>
  </article>;
}
