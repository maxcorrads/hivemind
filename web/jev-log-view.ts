import type { AdaptiveTopology } from '../src/shared/adaptive-topology.ts';
import type { JevCallSummary, JevCallTrigger } from '../src/shared/jev-calls.ts';
import { topologyLabel } from './AdaptiveRoutingPanel.tsx';

export function workersLabel(n: number): string { return `${n} worker${n === 1 ? '' : 's'}`; }
export function percent(value: number | null | undefined): string { return value == null ? '—' : `${Math.round(value * 100)}%`; }

/** Why Hivemind asked Jev, in plain words. */
export function triggerLabel(trigger: JevCallTrigger, phase: JevCallSummary['phase']): string {
  switch (trigger.kind) {
    case 'human_request': return 'Your new request';
    case 'human_message': return phase === 'initial' ? 'Your thread reply (new request)' : 'Your reply in the thread';
    case 'brain_message': return `Brain message${trigger.eventType ? ` · ${trigger.eventType}` : ''}`;
    case 'delegation_attempt': return 'Brain tried to delegate';
    case 'task_event': return `Brain task update${trigger.eventType ? ` · ${trigger.eventType}` : ''}`;
    case 'room_event': return 'Brain changed a room';
    case 'capacity_change': return 'Worker capacity changed';
    case 'observation': return 'No single brain owns this request';
  }
}

const REASONS: Record<string, string> = {
  single_sufficient: 'The brain alone is enough',
  one_worker_sufficient: 'One worker is enough',
  parallel_workstreams: 'Independent parallel workstreams',
  shared_coordination_pressure: 'Workers need shared coordination',
  orchestration_needed_no_capacity: 'Needs workers, but none are available',
  provider_timeout_preserve_current: 'Jev timed out · mode kept',
  provider_unavailable_preserve_current: 'Jev unavailable · mode kept',
  capacity_changed_during_evaluation_preserve_current: 'Capacity kept changing · mode kept',
  capacity_changed_during_initial_routing: 'Capacity changed during the call',
};
export function reasonLabel(reason: string): string { return REASONS[reason] ?? reason.replaceAll('_', ' '); }

/** Jev's answer in one line. */
export function answerLabel(call: Pick<JevCallSummary, 'status' | 'targetTopology' | 'targetWorkers' | 'confidence' | 'error'>): string {
  if (call.status === 'unavailable') return `No answer · ${call.error ?? 'unavailable'}`;
  return `${topologyLabel(call.targetTopology)}${call.targetWorkers ? ` · ${workersLabel(call.targetWorkers)}` : ''} · ${percent(call.confidence)}`;
}

/** What Hivemind did with the answer. */
export function outcomeLabel(call: Pick<JevCallSummary, 'outcome' | 'status' | 'targetTopology'>): { text: string; tone: 'applied' | 'kept' | 'warning' | 'idle' } {
  const outcome = call.outcome;
  if (!outcome) return call.status === 'unavailable'
    ? { text: 'Current mode kept', tone: 'warning' }
    : { text: 'Not used · routing state changed during the call', tone: 'idle' };
  if (outcome.kind === 'observation') return { text: 'Recorded only · not enforced', tone: 'idle' };
  if (outcome.kind === 'transition' || outcome.applied)
    return { text: `Applied → ${topologyLabel(outcome.appliedTopology)}${outcome.appliedWorkers ? ` · ${workersLabel(outcome.appliedWorkers)}` : ''}`, tone: 'applied' };
  if (outcome.kind === 'warning') return { text: `⚠ ${outcome.warning ?? 'Warning'}`, tone: 'warning' };
  if (outcome.kind === 'lock') return { text: `Your lock kept ${topologyLabel(outcome.appliedTopology)}`, tone: 'kept' };
  return outcome.appliedTopology === call.targetTopology
    ? { text: `Mode confirmed · ${topologyLabel(outcome.appliedTopology)}`, tone: 'kept' }
    : { text: `Kept ${topologyLabel(outcome.appliedTopology)} · waiting for confirmation`, tone: 'kept' };
}

const QUESTIONS: Record<string, string> = {
  single_agent_sufficiency: 'Can the brain handle it alone?',
  complexity: 'How complex is the remaining work?',
  parallelizability: 'How much can run in parallel?',
  coupling: 'How coupled are the workstreams?',
  specialization_need: 'How much does specialist expertise help?',
  coordination_need: 'How much coordination do workers need?',
  target_topology: 'Best way to organize the work',
  worker_budget: 'How many workers are needed?',
};
const SCORE_WORDS = ['Low', 'Medium', 'High'];

function choiceLabel(choice: string): string {
  if (choice === 'sufficient') return 'Yes, alone is enough';
  if (choice === 'insufficient') return 'No, delegation helps';
  if (choice === 'capacity_blocked') return 'Needs workers, none available';
  if (choice.startsWith('workers_')) return workersLabel(Number(choice.slice('workers_'.length)));
  return ['single', 'brain_one_worker', 'brain_multi_dm', 'brain_multi_room'].includes(choice) ? topologyLabel(choice as AdaptiveTopology) : choice;
}

export type QuestionRow = {
  id: string; question: string; answer: string; confidence: number | null;
  /** Normalized 0..1 for score questions, to draw a bar. */
  score: number | null;
  options: Array<{ label: string; probability: number; chosen: boolean }>;
};

/** Pairs every question sent to Jev with its answer, readable and defensive against malformed data. */
export function questionRows(sent: unknown, received: unknown): QuestionRow[] {
  const questions = (sent as { questions?: Record<string, { type?: string }> } | null)?.questions ?? {};
  const answers = (received as { answers?: Record<string, Record<string, unknown>> } | null)?.answers ?? {};
  return Object.entries(questions).map(([id, question]) => {
    const raw = answers[id] ?? {};
    const probabilities = raw.probabilities && typeof raw.probabilities === 'object' ? raw.probabilities as Record<string, number> : {};
    const score = typeof raw.score === 'number' ? raw.score : null;
    const choice = typeof raw.choice === 'string' ? raw.choice : null;
    const answer = question.type === 'score'
      ? score === null ? 'No answer' : `${SCORE_WORDS[Math.min(2, Math.max(0, Math.round(score)))]} (${score.toFixed(2)} / 2)`
      : choice === null ? 'No answer' : choiceLabel(choice);
    const options = Object.entries(probabilities).map(([key, probability]) => ({
      label: question.type === 'score' ? SCORE_WORDS[Number(key)] ?? key : choiceLabel(key),
      probability: Number(probability) || 0, chosen: question.type === 'score' ? Math.round(score ?? -1) === Number(key) : key === choice,
    }));
    return { id, question: QUESTIONS[id] ?? id.replaceAll('_', ' '), answer,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
      score: score === null ? null : score / 2, options };
  });
}

/** The context Hivemind sent alongside the request, as label/value pairs. */
export function contextRows(sent: unknown): Array<[string, string]> {
  const state = (sent as { state?: Record<string, unknown> } | null)?.state;
  if (!state) return [];
  const current = state.current as { topology: AdaptiveTopology; workerBudget: number; desiredTopology: AdaptiveTopology | null } | null;
  const capacity = state.capacity as { workers?: { free?: number; busyCurrent?: number; busyOther?: number; online?: number; total?: number } } | undefined;
  const tasks = state.tasks as { active?: number; blockers?: number; openDependencies?: number } | undefined;
  const execution = state.execution as { lockedTopology?: AdaptiveTopology | null; lockScope?: string; orchestratedOnly?: boolean } | undefined;
  const trigger = state.trigger as { summary?: string } | undefined;
  const w = capacity?.workers ?? {};
  const rows: Array<[string, string]> = [
    ['Mode at the time', current ? `${topologyLabel(current.topology)}${current.workerBudget ? ` · ${workersLabel(current.workerBudget)}` : ''}${current.desiredTopology ? ` · pending → ${topologyLabel(current.desiredTopology)}` : ''}` : 'None yet (first call)'],
    ['Workers', `${w.free ?? 0} free · ${w.busyCurrent ?? 0} on this request · ${w.busyOther ?? 0} busy elsewhere · ${w.online ?? 0}/${w.total ?? 0} online`],
    ['Delegated work', `${tasks?.active ?? 0} active · ${tasks?.blockers ?? 0} blocked · ${tasks?.openDependencies ?? 0} open dependencies`],
  ];
  if (execution?.lockedTopology) rows.push(['Your lock', `${topologyLabel(execution.lockedTopology)} · ${execution.lockScope}`]);
  if (execution?.orchestratedOnly) rows.push(['Your choice', 'Orchestration required']);
  if (trigger?.summary) rows.push(['Triggering message', trigger.summary]);
  return rows;
}
