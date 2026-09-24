import { Modal } from "./Modal.tsx";
import { useId, useState, type KeyboardEvent } from "react";
import { primaryExecution } from "./adaptive-routing-view.ts";
import { captureLabel, CollectorHealthNotice } from "./EvidenceHealth.tsx";
import type { AdaptiveExecutionState, AdaptiveRoutingEvent, AdaptiveRoutingView,
  AdaptiveTopologyDecision } from "../src/shared/adaptive-topology.ts";
import { jevAdviceLabel, jevAnswerState, planLabel } from "../src/shared/jev-outcome.ts";
import { triggerLabel } from "./jev-log-view.ts";

type DecisionLike = Pick<AdaptiveTopologyDecision, "providerStatus" | "confidence" | "reason" | "targetTopology" | "targetWorkers"
  | "incoherent" | "error"> & Partial<Pick<AdaptiveTopologyDecision, "model" | "inputTokens">>;
const decisionOf = (value: DecisionLike) => ({ ...value, model: value.model ?? null, inputTokens: value.inputTokens ?? null });

/**
 * The strip text (#211): `Jev suggests: Multi-DM · 2 workers (72%)` for a confident answer, otherwise the precise state
 * (`Jev uncertain (41%) · Brain + 1`, `Jev unavailable (timeout)`).
 */
export function adviceSummary(decision: DecisionLike): string {
  const value = decisionOf(decision);
  if (jevAnswerState(value) !== "answered") return jevAdviceLabel(value);
  return `Jev suggests: ${planLabel(value)} (${Math.round((value.confidence ?? 0) * 100)}%)`;
}

/** One line of the Human-only advice audit. Nothing in it was enforced. */
export function routingEventLabel(event: AdaptiveRoutingEvent): string {
  if (event.kind === "status") return `Hivemind · ${event.reason === "execution_completed" ? "request closed · no more advice"
    : event.reason === "execution_reopened" ? "request reopened" : event.reason.replaceAll("_", " ")}`;
  const advice = jevAdviceLabel(decisionOf(event));
  if (event.kind === "observation") return `No single owning brain · ${advice} · recorded only`;
  const trigger = event.trigger ? triggerLabel({ kind: event.trigger as never, eventType: null }, "continuous") : "Jev";
  return `${trigger} · ${advice}`;
}

type PanelProps = {
  channelId: string; view: AdaptiveRoutingView;
  /** Display names for brains, keyed by agent ID. */
  brainNames?: Record<string, string>;
  onClose: () => void;
};

/** Human-only Routing panel (#211): Jev's latest advice per brain and its audit. Advice is never applied or locked. */
export function AdaptiveRoutingPanel({ channelId, view, brainNames, onClose }: PanelProps) {
  const executions = (view.executions?.length ? view.executions : view.state ? [view.state] : [])
    .filter(item => item.channelId === channelId);
  const [brainId, setBrainId] = useState<string | null>(null);
  const state = executions.find(item => item.brainId === brainId) ?? primaryExecution(executions);
  const events = view.events.filter(event => event.channelId === channelId &&
    (executions.length < 2 || !state || event.executionId === state.executionId || event.kind === "observation"));
  const name = (id: string) => brainNames?.[id] ?? "Brain";
  const panelId = useId();
  const tabbed = executions.length > 1;
  // Roving tabs: only the selected brain is in the tab order; arrows/Home/End move and select.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = executions.findIndex(item => item.executionId === state?.executionId);
    const next = event.key === "Home" ? 0 : event.key === "End" ? executions.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + executions.length) % executions.length;
    setBrainId(executions[next]!.brainId);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <Modal onClose={onClose}>
      <div className="sheet routing-sheet" role="dialog" aria-modal="true" aria-label="Jev advice"
        onClick={event => event.stopPropagation()}>
        <h2>Routing · Jev</h2>
        {tabbed && <div className="routing-executions" role="tablist" aria-label="Brains" onKeyDown={onTabKey}>
          {executions.map(item => {
            const selected = item.executionId === state?.executionId;
            return <button key={item.executionId} type="button" role="tab" aria-selected={selected} aria-controls={panelId}
              tabIndex={selected ? 0 : -1} onClick={() => setBrainId(item.brainId)}>{name(item.brainId)}</button>;
          })}
        </div>}
        <div className="sheet-body" id={panelId} role={tabbed ? "tabpanel" : undefined}
          aria-label={tabbed && state ? name(state.brainId) : undefined}>
        <CollectorHealthNotice health={view.collector} />
        <p className="help-p">Jev only advises the brain. Its suggestion is returned with each brain action and never enforced: the brain decides, and your instructions always take precedence.</p>
        {!state ? <p className="help-p">No request to a brain has been sent to Jev in this channel yet.</p> : <AdviceSummary state={state} />}
        <h3>Jev advice</h3>
        <p className="help-p">Human-only audit: these entries are not messages delivered to agents.</p>
        <div className="routing-events">
          {events.length === 0 && <p className="help-p">No advice recorded yet.</p>}
          {[...events].reverse().map(event => <div key={event.id} className={`routing-event ${event.kind}`}>
            <span>{routingEventLabel(event)}</span><time>{new Date(event.createdAt).toLocaleTimeString()}</time>
          </div>)}
        </div>
        </div>
        <div className="row"><button type="button" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

function AdviceSummary({ state }: { state: AdaptiveExecutionState }) {
  return <>
    <div className="routing-summary">
      <strong>{state.recommendation ? adviceSummary(state.recommendation) : "No advice yet"}</strong>
    </div>
    {state.monitoring === "disabled" && <p className="help-p" role="status">Jev disabled · brains get no advice.</p>}
    {state.monitoring === "completed" && <p className="help-p" role="status">Request closed. Jev gives no further advice for it.</p>}
    {state.evidence && <p className={state.evidence.capture === "complete" ? "help-p" : "routing-warning"} role="status">{captureLabel(state.evidence)}</p>}
  </>;
}
