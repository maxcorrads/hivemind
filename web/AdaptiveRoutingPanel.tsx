import { useState } from "react";
import {
  api,
} from "./api.ts";
import type {
  AdaptiveLockScope,
  AdaptiveRoutingEvent,
  AdaptiveRoutingView,
  AdaptiveTopology,
} from "../src/shared/adaptive-topology.ts";

export function topologyLabel(topology: AdaptiveTopology): string {
  if (topology === "single") return "Single";
  if (topology === "brain_one_worker") return "Brain + 1";
  if (topology === "brain_multi_dm") return "Multi-DM";
  return "Room";
}

export function routingEventLabel(event: AdaptiveRoutingEvent): string {
  const confidence = event.confidence == null ? "" : ` · ${Math.round(event.confidence * 100)}%`;
  const workers = event.targetWorkers > 0 ? ` · ${event.targetWorkers} worker${event.targetWorkers === 1 ? "" : "s"}` : "";
  if (event.kind === "transition")
    return `${topologyLabel(event.fromTopology)} → ${topologyLabel(event.appliedTopology)}${workers}${confidence} · ${event.reason}`;
  if (event.kind === "warning") return `⚠ ${event.warning ?? event.reason}`;
  return `Jev · ${topologyLabel(event.targetTopology)}${workers}${confidence} · ${event.reason}`;
}

export function AdaptiveRoutingPanel({
  channelId,
  view,
  onChange,
  onClose,
}: {
  channelId: string;
  view: AdaptiveRoutingView;
  onChange: (view: AdaptiveRoutingView) => void;
  onClose: () => void;
}) {
  const state = view.state;
  const [scope, setScope] = useState<AdaptiveLockScope>(state?.lockScope ?? "task");
  const [topology, setTopology] = useState<AdaptiveTopology>(
    state?.lockedTopology ?? state?.currentTopology ?? "single",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = (body: { scope: AdaptiveLockScope; topology?: AdaptiveTopology | null }) => {
    setBusy(true);
    setError(null);
    api.setAdaptiveRoutingLock(channelId, body)
      .then(onChange)
      .catch(err => setError(String(err.message || err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet routing-sheet" role="dialog" aria-modal="true" aria-label="Adaptive routing timeline"
        onClick={e => e.stopPropagation()}>
        <h2>Routing · Jev</h2>
        {!state ? <p className="help-p">No adaptive execution has started in this brain DM yet.</p> : <>
          <div className="routing-summary">
            <strong>{topologyLabel(state.currentTopology)}</strong>
            {state.workerBudget > 0 && <span>{state.workerBudget} worker{state.workerBudget === 1 ? "" : "s"}</span>}
            {state.desiredTopology && <span>target → {topologyLabel(state.desiredTopology)}</span>}
            {state.lockScope !== "none" && <span>locked · {state.lockScope}</span>}
          </div>
          {state.warning && <p className="routing-warning">⚠ {state.warning}</p>}
          {state.recommendation && <p className="help-p">
            Latest Jev recommendation: <strong>{topologyLabel(state.recommendation.targetTopology)}</strong>
            {state.recommendation.targetWorkers > 0 ? ` · ${state.recommendation.targetWorkers} worker${state.recommendation.targetWorkers === 1 ? "" : "s"}` : ""}
            {state.recommendation.confidence != null ? ` · ${Math.round(state.recommendation.confidence * 100)}%` : ""}
          </p>}
          <fieldset className="routing-lock">
            <legend>Human topology lock</legend>
            <label>
              Topology
              <select value={topology} onChange={e => setTopology(e.target.value as AdaptiveTopology)} disabled={busy}>
                <option value="single">Single</option>
                <option value="brain_one_worker">Brain + 1</option>
                <option value="brain_multi_dm">Multi-DM</option>
                <option value="brain_multi_room">Room</option>
              </select>
            </label>
            <label>
              Scope
              <select value={scope} onChange={e => setScope(e.target.value as AdaptiveLockScope)} disabled={busy}>
                <option value="task">Task</option>
                <option value="conversation">Conversation</option>
              </select>
            </label>
            <div className="row">
              <button type="button" disabled={busy} onClick={() => mutate({ scope: "none" })}>Unlock</button>
              <button type="button" className="primary" disabled={busy}
                onClick={() => mutate({ scope, topology })}>Apply lock</button>
            </div>
          </fieldset>
        </>}
        <h3>Jev evaluations</h3>
        <div className="routing-events">
          {view.events.length === 0 && <p className="help-p">No evaluations recorded yet.</p>}
          {[...view.events].reverse().map(event => (
            <div key={event.id} className={`routing-event ${event.kind}`}>
              <span>{routingEventLabel(event)}</span>
              <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
            </div>
          ))}
        </div>
        {error && <p className="err">{error}</p>}
        <div className="row"><button type="button" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
