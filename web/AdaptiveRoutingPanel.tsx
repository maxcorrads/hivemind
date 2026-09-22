import { Modal } from "./Modal.tsx";
import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type {
  AdaptiveExecutionState, AdaptiveLockScope, AdaptiveRoutingEvent,
  AdaptiveRoutingView, AdaptiveTopology,
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
  if (event.kind === "status") return `Hivemind · ${event.reason.replaceAll("_", " ")}`;
  if (event.kind === "lock") return `Human · ${event.reason} · ${topologyLabel(event.appliedTopology)}`;
  if (event.providerStatus === "bypassed") return `Manual · ${topologyLabel(event.appliedTopology)} · Jev not called`;
  return `Jev recommends ${topologyLabel(event.targetTopology)}${workers}${confidence} · ${event.reason}`;
}

type PanelProps = {
  channelId: string; view: AdaptiveRoutingView;
  onChange: (view: AdaptiveRoutingView) => void; onClose: () => void;
};

export function AdaptiveRoutingPanel(props: PanelProps) {
  const state = props.view.state?.channelId === props.channelId ? props.view.state : null;
  const events = props.view.events.filter(event => event.channelId === props.channelId);
  // Never retain an editor or its asynchronous response when navigating to another execution.
  return <RoutingPanelContent key={`${props.channelId}:${state?.executionId ?? "none"}`}
    {...props} state={state} events={events} />;
}

function RoutingPanelContent({ channelId, state, events, onChange, onClose }: PanelProps & {
  state: AdaptiveExecutionState | null; events: AdaptiveRoutingEvent[];
}) {
  const [scope, setScope] = useState<Exclude<AdaptiveLockScope, "none">>(
    state?.lockScope === "conversation" ? "conversation" : "task",
  );
  const [topology, setTopology] = useState<AdaptiveTopology>(state?.lockedTopology ?? state?.currentTopology ?? "single");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = () => { if (!busy) onClose(); };
  const mutate = (body: { scope: AdaptiveLockScope; topology?: AdaptiveTopology | null }) => {
    if (busy) return;
    setBusy(true); setError(null);
    api.setAdaptiveRoutingLock(channelId, { ...body, expectedExecutionId: state?.executionId, expectedRevision: state?.revision }).then(next => {
      if (mounted.current && next.state?.channelId === channelId && next.state.executionId === state?.executionId)
        onChange(next);
    }).catch(err => {
      if (mounted.current) setError(String(err.message || err));
    }).finally(() => { if (mounted.current) setBusy(false); });
  };

  return (
    <Modal onClose={close}>
      <div className="sheet routing-sheet" role="dialog" aria-modal="true" aria-label="Adaptive routing timeline"
        onClick={event => event.stopPropagation()}>
        <h2>Routing · Jev</h2>
        <div className="sheet-body">
        {!state ? <p className="help-p">No adaptive execution has started in this brain DM yet.</p> : <>
          <div className="routing-summary">
            <strong>{topologyLabel(state.currentTopology)}</strong>
            {state.workerBudget > 0 && <span>{state.workerBudget} worker{state.workerBudget === 1 ? "" : "s"}</span>}
            {state.desiredTopology && <span>pending → {topologyLabel(state.desiredTopology)}</span>}
            {state.lockedTopology && <span>Human override · {state.lockScope === "none" ? "this request" : state.lockScope}</span>}
          </div>
          {state.monitoring === "disabled" && <p className="routing-warning" role="status">Jev disabled · automatic verification is off. Manual locks remain authoritative.</p>}
          {state.monitoring === "pending" && <p className="help-p" role="status">Jev enabled · awaiting the next coordination event.</p>}
          {state.monitoring === "completed" && <p className="help-p" role="status">Execution completed. No further Jev calls are scheduled for this request.</p>}
          {state.warning && <p className="routing-warning" role="alert">⚠ {state.warning}</p>}
          {state.recommendation?.providerStatus === "ok" && <p className="help-p">
            Latest Jev recommendation: <strong>{topologyLabel(state.recommendation.targetTopology)}</strong>
            {state.recommendation.targetWorkers > 0 ? ` · ${state.recommendation.targetWorkers} worker${state.recommendation.targetWorkers === 1 ? "" : "s"}` : ""}
            {state.recommendation.confidence != null ? ` · ${Math.round(state.recommendation.confidence * 100)}%` : ""}
            {state.lockedTopology ? " · recommendation only; Human override remains authoritative" : ""}
          </p>}
          {state.recommendation?.providerStatus === "bypassed" && <p className="help-p">Manual selection · Jev was not called for this decision.</p>}
          <fieldset className="routing-lock" disabled={Boolean(state.completedAt)}>
            <legend>Human topology lock</legend>
            <label>Topology
              <select value={topology} onChange={event => setTopology(event.target.value as AdaptiveTopology)} disabled={busy}>
                <option value="single">Single</option><option value="brain_one_worker">Brain + 1</option>
                <option value="brain_multi_dm">Multi-DM</option><option value="brain_multi_room">Room</option>
              </select>
            </label>
            <label>Scope
              <select value={scope} onChange={event => setScope(event.target.value as Exclude<AdaptiveLockScope, "none">)} disabled={busy}>
                <option value="task">Task</option><option value="conversation">Conversation</option>
              </select>
            </label>
            <div className="row">
              <button type="button" disabled={busy || !state.lockedTopology} onClick={() => mutate({ scope: "none" })}>Unlock</button>
              <button type="button" className="primary" disabled={busy} onClick={() => mutate({ scope, topology })}>Apply lock</button>
            </div>
          </fieldset>
        </>}
        <h3>Jev evaluations</h3>
        <p className="help-p">Human-only audit: these entries are not messages delivered to agents.</p>
        <div className="routing-events">
          {events.length === 0 && <p className="help-p">No evaluations recorded yet.</p>}
          {[...events].reverse().map(event => <div key={event.id} className={`routing-event ${event.kind}`}>
            <span>{routingEventLabel(event)}</span><time>{new Date(event.createdAt).toLocaleTimeString()}</time>
          </div>)}
        </div>
        {error && <p className="err" role="alert">{error}</p>}
        </div>
        <div className="row"><button type="button" disabled={busy} onClick={close}>Close</button></div>
      </div>
    </Modal>
  );
}
