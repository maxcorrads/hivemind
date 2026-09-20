import { useEffect, useState } from 'react';
import type { TimelineExport, TimelineView } from '../src/shared/timeline.ts';
import { api } from './api.ts';

function label(event: TimelineView['events'][number]) {
  if (event.kind === 'delivery') return `${event.stage} → ${event.agentName} · ${event.wakeReason}`;
  const action = event.taskAction ? ` · ${event.taskAction}` : '';
  return `${event.authorName} · ${event.eventType ?? 'message'}${action}`;
}

export function TimelinePanel({ taskId }: { taskId: string }) {
  const [timeline, setTimeline] = useState<TimelineView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try { setTimeline((await api.taskTimeline(taskId)).timeline); }
    catch (reason) { setError(String(reason)); }
  };
  useEffect(() => { void load(); }, [taskId]);

  const download = async () => {
    try {
      const fixture: TimelineExport = (await api.exportTaskTimeline(taskId)).fixture;
      const blob = new Blob([JSON.stringify(fixture, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = href; a.download = `hivemind-timeline-${taskId}.json`; a.click(); URL.revokeObjectURL(href);
    } catch (reason) { setError(String(reason)); }
  };

  return <details className="task-timeline">
    <summary>Coordination timeline{timeline?.truncated ? ' · truncated' : ''}</summary>
    <div className="timeline-tools">
      <button type="button" className="text-btn" onClick={() => void load()}>Refresh</button>
      <button type="button" className="text-btn" onClick={() => void download()}>Export redacted fixture</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!timeline && !error && <p>Loading timeline…</p>}
    {timeline && <>
      <small>{timeline.warning}</small>
      {timeline.events.length === 0 && <p>No timeline events retained for this task.</p>}
      <ol className="timeline-list">
        {timeline.events.map(event => <li key={event.id}>
          <time>{new Date(event.at).toLocaleTimeString()}</time>
          <span>{label(event)}</span>
          {event.kind === 'message' && event.relation && <small>
            Cause: {event.relation.kind === 'explicit' ? 'explicit reference' : 'inferred thread parent'} · {event.relation.messageId}
          </small>}
          {event.kind === 'delivery' && <small>delivery {event.deliveryId.slice(0, 8)} · attempt {event.attempt}</small>}
        </li>)}
      </ol>
    </>}
  </details>;
}
