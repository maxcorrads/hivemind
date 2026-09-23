import { Modal } from "./Modal.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api.ts";
import { drainingExecutions, isCurrentExecution } from "./adaptive-routing-view.ts";
import { captureLabel, CollectorHealthNotice } from "./EvidenceHealth.tsx";
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
  if (event.kind === "observation")
    return `Jev observed · no single owning brain · would choose ${topologyLabel(event.targetTopology)}${workers}${confidence} · not enforced`;
  if (event.providerStatus === "bypassed") return `Manual · ${topologyLabel(event.appliedTopology)} · Jev not called`;
  return `Jev recommends ${topologyLabel(event.targetTopology)}${workers}${confidence} · ${event.reason}`;
}

type PanelProps = {
  channelId: string; view: AdaptiveRoutingView;
  /** Display names for brains, keyed by agent ID. */
  brainNames?: Record<string, string>;
  onChange: (view: AdaptiveRoutingView) => void; onClose: () => void;
};

export function AdaptiveRoutingPanel(props: PanelProps) {
  const all = (props.view.executions?.length ? props.view.executions : props.view.state ? [props.view.state] : [])
    .filter(item => item.channelId === props.channelId);
  // Tabs and locks cover each brain's current execution; replaced ones still draining are listed read-only.
  const executions = all.filter(isCurrentExecution);
  const [brainId, setBrainId] = useState<string | null>(null);
  const primary = props.view.state?.channelId === props.channelId && isCurrentExecution(props.view.state) ? props.view.state : null;
  // Each brain in a channel owns its own execution; the lock applies to the one selected here.
  const state = executions.find(item => item.brainId === brainId) ?? primary;
  // A brain without a current execution (replaced by an unrouted request) still shows its draining work.
  const draining = drainingExecutions(all).filter(item => !state || item.brainId === state.brainId ||
    !executions.some(current => current.brainId === item.brainId));
  const shown = new Set(draining.map(item => item.executionId));
  const events = props.view.events.filter(event => event.channelId === props.channelId &&
    (executions.length < 2 || !state || event.executionId === state.executionId || shown.has(event.executionId) || event.kind === "observation"));
  const name = (id: string) => props.brainNames?.[id] ?? "Brain";
  const tabs = executions.length > 1 ? <div className="routing-executions" role="tablist" aria-label="Brain executions">
    {executions.map(item => <button key={item.executionId} type="button" role="tab" aria-selected={item.executionId === state?.executionId}
      onClick={() => setBrainId(item.brainId)}>{name(item.brainId)} · {topologyLabel(item.currentTopology)}</button>)}
  </div> : null;
  const finishing = draining.length ? <DrainingList executions={draining}
    name={new Set(all.map(item => item.brainId)).size > 1 ? name : null} /> : null;
  // Never retain an editor or its asynchronous response when navigating to another execution.
  return <RoutingPanelContent key={`${props.channelId}:${state?.executionId ?? "none"}`}
    {...props} state={state} events={events} tabs={tabs} finishing={finishing} />;
}

function openWorkLabel(work: AdaptiveExecutionState["openWork"]): string {
  if (!work) return "delegated work still open";
  const parts = [work.tasks ? `${work.tasks} task${work.tasks === 1 ? "" : "s"}` : "",
    work.delegations ? `${work.delegations} delegation${work.delegations === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.length ? `${parts.join(" · ")} open` : "settling";
}

/** Read-only: replaced requests complete automatically when their delegated work ends. */
function DrainingList({ executions, name }: { executions: AdaptiveExecutionState[]; name: ((id: string) => string) | null }) {
  return <section className="routing-draining" aria-label="Still finishing">
    <h3>Still finishing</h3>
    <p className="help-p">Earlier requests replaced by a newer one. They complete automatically when their delegated work ends; locks apply only to the current request.</p>
    <ul>
      {executions.map(item => <li key={item.executionId}>
        {item.requestExcerpt && <q>{item.requestExcerpt}</q>}
        <span>
          {name ? `${name(item.brainId)} · ` : ""}{topologyLabel(item.currentTopology)}
          {item.workerBudget > 0 ? ` · ${item.workerBudget} worker${item.workerBudget === 1 ? "" : "s"}` : ""}
          {` · ${openWorkLabel(item.openWork)}`}
        </span>
      </li>)}
    </ul>
  </section>;
}

function RoutingPanelContent({ channelId, view, state, events, tabs, finishing, onChange, onClose }: PanelProps & {
  state: AdaptiveExecutionState | null; events: AdaptiveRoutingEvent[]; tabs: ReactNode; finishing: ReactNode;
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
        {tabs}
        <div className="sheet-body">
        <CollectorHealthNotice health={view.collector} />
        {!state ? <p className="help-p">No adaptive execution has started in this channel yet. Every Human message addressed to a brain here is routed through Jev.</p> : <>
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
          {state.evidence && <p className={state.evidence.capture === "complete" ? "help-p" : "routing-warning"} role="status">{captureLabel(state.evidence)}</p>}
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
        {finishing}
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
