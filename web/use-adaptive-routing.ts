import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { mergeRoutingView } from './adaptive-routing-view.ts';
import type { AdaptiveExecutionState, AdaptiveRoutingEvent, AdaptiveRoutingView } from '../src/shared/adaptive-topology.ts';

export function useAdaptiveRouting(channelId: string | null) {
  const selected = useRef(channelId);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const [stored, setStored] = useState<{ channelId: string; view: AdaptiveRoutingView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (selected.current !== channelId) { selected.current = channelId; generation.current++; }

  const merge = useCallback((incoming: AdaptiveRoutingView, target: string) => {
    if (selected.current !== target) return;
    setStored(current => ({ channelId: target,
      view: mergeRoutingView(current?.channelId === target ? current.view : null, incoming, target) }));
  }, []);
  const refresh = useCallback((baseline = false) => {
    const target = selected.current;
    request.current?.abort();
    const ticket = ++generation.current;
    if (baseline) setStored(null);
    if (!target) return;
    const abort = new AbortController(); request.current = abort;
    api.adaptiveRoutingView(target, abort.signal).then(next => {
      if (!abort.signal.aborted && ticket === generation.current && target === selected.current) {
        merge(next, target); setError(null);
      }
    }).catch(err => {
      if (!abort.signal.aborted && ticket === generation.current) setError(String(err.message || err));
    });
  }, [merge]);
  useEffect(() => {
    setStored(null); setError(null); refresh();
    return () => { generation.current++; request.current?.abort(); };
  }, [channelId, refresh]);

  // Observations (no single owning brain) carry an audit event without an execution state.
  const onEvent = useCallback((payload: { channelId: string; event: AdaptiveRoutingEvent; state: AdaptiveExecutionState | null }) => {
    if ((payload.state && payload.state.channelId !== payload.channelId) || payload.event.channelId !== payload.channelId) return;
    merge({ state: payload.state, events: [payload.event] }, payload.channelId);
  }, [merge]);
  const onChange = useCallback((next: AdaptiveRoutingView) => {
    const target = next.state?.channelId ?? next.executions?.[0]?.channelId;
    if (target) merge(next, target);
  }, [merge]);
  return { view: stored?.channelId === channelId ? stored.view : null, error, refresh, onEvent, onChange };
}
