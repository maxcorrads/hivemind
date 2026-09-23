import { randomUUID } from 'node:crypto';
import { TYPESAFE_ENDPOINT, TYPESAFE_MODEL } from './adaptive-routing.ts';
import type { AdaptiveTopology, AdaptiveTopologyDecision, AdaptiveWorkerCapacity, AdaptiveLockScope } from '../shared/adaptive-topology.ts';
import { validTopologyTarget } from '../shared/adaptive-topology-policy.ts';

export const ADAPTIVE_TOPOLOGY_CONTRACT_VERSION = 'adaptive-routing-v2' as const;
const MAX_RESPONSE_BYTES = 128 * 1024;
function ensure(value: unknown, message = 'Invalid Jev response'): asserts value {
  if (!value) throw new Error(message);
}
// TypeSafe Choice accepts at most 255 options, including the zero-worker option.
export const MAX_CLASSIFIER_WORKERS = 254;

export type TopologyCapacitySnapshot = {
  workers: AdaptiveWorkerCapacity;
  activeTasks: number;
  activeWorkers: number;
  blockers: number;
  openDependencies: number;
  workstreams: number;
  unreconciledClaims?: number;
};
export type TopologyEvaluationSnapshot = {
  request: string;
  project: { slug: string; name: string };
  current: { topology: AdaptiveTopology; workerBudget: number;
    desiredTopology: AdaptiveTopology | null; desiredWorkers: number | null } | null;
  capacity: TopologyCapacitySnapshot;
  execution: { orchestratedOnly: boolean; lockScope: AdaptiveLockScope; lockedTopology: AdaptiveTopology | null };
  tasks: { active: number; activeWorkers: number; blockers: number; openDependencies: number; workstreams: number };
  recentCoordinationEvents: readonly unknown[];
  trigger: unknown;
  previousDecision: AdaptiveTopologyDecision | null;
};

type Answer = { type: string; confidence: number; probabilities: Record<string, number>; choice?: string; score?: number };
function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function answer(raw: unknown, type: 'choice' | 'score', options: string[]): Answer {
  ensure(raw && typeof raw === 'object' && !Array.isArray(raw));
  const value = raw as Record<string, unknown>;
  ensure(value.type === type);
  ensure(probability(value.confidence));
  ensure(value.probabilities && typeof value.probabilities === 'object' && !Array.isArray(value.probabilities));
  const entries = Object.entries(value.probabilities);
  ensure(entries.length === options.length && entries.every(([key]) => options.includes(key)));
  ensure(entries.every(([, p]) => probability(p)));
  const distribution = Object.fromEntries(entries) as Record<string, number>;
  ensure(Math.abs(Object.values(distribution).reduce((sum, p) => sum + p, 0) - 1) <= 0.02);
  if (type === 'choice') {
    ensure(typeof value.choice === 'string' && options.includes(value.choice));
    ensure(distribution[value.choice]! + 1e-9 >= Math.max(...Object.values(distribution)));
  } else ensure(typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= 0 && value.score <= 2);
  return { type, confidence: value.confidence, probabilities: distribution,
    ...(type === 'choice' ? { choice: value.choice as string } : { score: value.score as number }) };
}

export function topologyQuestions(snapshot: TopologyEvaluationSnapshot) {
  const usable = Math.min(MAX_CLASSIFIER_WORKERS, snapshot.capacity.workers.usableForExecution);
  ensure(Number.isSafeInteger(usable) && usable >= 0);
  const topologies: Record<string, string> = {};
  if (!snapshot.execution.orchestratedOnly || usable === 0)
    topologies.single = 'The brain alone can safely complete the remaining work. Zero workers.';
  if (usable >= 1) topologies.brain_one_worker = 'Exactly one worker provides useful specialization or delegation.';
  if (usable >= 2) {
    topologies.brain_multi_dm = 'At least two independent worker workstreams, coordinated by the brain via separate DMs.';
    topologies.brain_multi_room = 'At least two workers need shared decisions, peer clarification or common coordination state.';
  }
  if (usable === 0 || Object.keys(topologies).length === 1)
    topologies.capacity_blocked = 'The necessary orchestration is not feasible with this capacity. Keep doing safe local work and report missing capacity.';
  const budgets = Object.fromEntries(Array.from({ length: usable + 1 }, (_, n) => [
    `workers_${n}`, n === 0 ? 'The next phase needs no workers.' : `The next phase needs exactly ${n} workers in total, including workers already assigned to this execution.`,
  ]));
  const questions: Record<string, unknown> = {
    single_agent_sufficiency: { type: 'choice', instructions: 'Can the brain alone safely complete the next phase?', criteria: {
      sufficient: 'One capable session is sufficient.', insufficient: 'Delegation or peer coordination materially benefits quality or completion.',
    } },
    complexity: { type: 'score', instructions: 'How complex is the remaining execution phase?', criteria: ['Bounded local work.', 'Several interacting steps.', 'Broad or highly coupled work.'] },
    parallelizability: { type: 'score', instructions: 'How much useful work can proceed independently now?', criteria: ['Sequential.', 'Some independent work.', 'Several substantial independent workstreams.'] },
    coupling: { type: 'score', instructions: 'How tightly coupled are the remaining workstreams?', criteria: ['Independent.', 'Some synchronization.', 'Shared state or frequent cross-decisions.'] },
    specialization_need: { type: 'score', instructions: 'How much does distinct specialist expertise help the next phase?', criteria: ['Little.', 'Useful.', 'Materially important.'] },
    coordination_need: { type: 'score', instructions: 'How much active coordination between workers is needed?', criteria: ['None.', 'Handoffs and occasional synchronization.', 'Shared decisions or peer clarification.'] },
    target_topology: { type: 'choice', instructions: {
      question: 'Choose the best feasible topology for the next phase, using only the options below. Do not choose specific workers or subtasks.',
      free_workers: snapshot.capacity.workers.free,
      already_committed_to_this_execution: snapshot.capacity.workers.busyCurrent,
      maximum_total_workers: usable,
      human_requires_orchestration: snapshot.execution.orchestratedOnly,
    }, criteria: topologies },
  };
  if (usable > 0) questions.worker_budget = { type: 'choice', instructions:
    `How many total workers are actually needed for the next phase? Choose 0 for local single-session work, 1 for one-worker delegation, or 2..${usable} for parallel work. This includes workers already committed to this execution; do not count them twice.`, criteria: budgets };
  return { questions, topologies, budgets: usable > 0 ? budgets : null, usable };
}

async function responseJson(response: Response): Promise<unknown> {
  ensure(response.body, 'Provider body missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      ensure(bytes <= MAX_RESPONSE_BYTES, 'Provider response too large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** API contract: https://docs.typesafe.ai/api. No SDK, retries or externally supplied endpoint. */
export async function evaluateAdaptiveTopology(
  snapshot: TopologyEvaluationSnapshot,
  config: { apiKey: string },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal;
    /** Receives the exact request body (never the key) and the parsed response, for the Human-only call log. */
    onExchange?: (exchange: { sent: unknown | null; received: unknown | null; error: string | null }) => void } = {},
): Promise<AdaptiveTopologyDecision> {
  const routeId = `route-${randomUUID()}`;
  const started = Date.now();
  let sent: unknown | null = null, received: unknown | null = null;
  try {
    const timeout = options.timeoutMs ?? 2_000;
    ensure(Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 10_000);
    const { questions, topologies, budgets, usable } = topologyQuestions(snapshot);
    sent = { state: snapshot, model: TYPESAFE_MODEL, questions };
    const body = JSON.stringify(sent);
    ensure(Buffer.byteLength(body) <= 64 * 1024, 'Routing snapshot exceeds budget');
    const deadline = AbortSignal.timeout(timeout);
    const response = await (options.fetchImpl ?? fetch)(TYPESAFE_ENDPOINT, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`http_${response.status}`); }
    const raw = await responseJson(response);
    received = raw;
    ensure(raw && typeof raw === 'object' && !Array.isArray(raw));
    const envelope = raw as { model?: unknown; answers?: Record<string, unknown>; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    ensure(typeof envelope.model === 'string' && envelope.model.length > 0 && envelope.model.length <= 200);
    ensure(Number.isSafeInteger(envelope.usage?.input_tokens) && Number(envelope.usage?.input_tokens) >= 0);
    ensure(Number.isSafeInteger(envelope.usage?.output_tokens) && Number(envelope.usage?.output_tokens) >= 0);
    const a = envelope.answers ?? {};
    const sufficiency = answer(a.single_agent_sufficiency, 'choice', ['sufficient', 'insufficient']);
    const scores = ['complexity', 'parallelizability', 'coupling', 'specialization_need', 'coordination_need']
      .map(key => answer(a[key], 'score', ['0', '1', '2']));
    const topology = answer(a.target_topology, 'choice', Object.keys(topologies));
    const budget = budgets ? answer(a.worker_budget, 'choice', Object.keys(budgets)) : null;
    const blocked = topology.choice === 'capacity_blocked';
    const targetTopology = (blocked ? 'single' : topology.choice) as AdaptiveTopology;
    const targetWorkers = blocked ? 0 : budget ? Number(budget.choice!.slice('workers_'.length)) : 0;
    // A malformed or internally contradictory plan is not repaired into a different Jev decision.
    ensure(validTopologyTarget({ topology: targetTopology, workers: targetWorkers }, usable));
    const singleSufficient = sufficiency.choice === 'sufficient';
    ensure(blocked || targetTopology !== 'single' || singleSufficient || usable === 0, 'Contradictory Single decision');
    const confidence = Math.min(sufficiency.confidence, topology.confidence, ...scores.map(s => s.confidence), ...(budget ? [budget.confidence] : []));
    options.onExchange?.({ sent, received, error: null });
    return {
      routeId, contractVersion: ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
      targetTopology, targetWorkers, confidence,
      reason: blocked ? 'orchestration_needed_no_capacity' : targetTopology === 'single' ? 'single_sufficient'
        : targetTopology === 'brain_multi_room' ? 'shared_coordination_pressure'
          : targetTopology === 'brain_multi_dm' ? 'parallel_workstreams' : 'one_worker_sufficient',
      providerStatus: 'ok', model: envelope.model, latencyMs: Date.now() - started,
      inputTokens: Number(envelope.usage!.input_tokens), outputTokens: Number(envelope.usage!.output_tokens),
      singleSufficient, needsOrchestration: blocked || !singleSufficient,
    };
  } catch (error) {
    const timeout = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
    // Only local failure classes are kept: never a provider error body or header.
    options.onExchange?.({ sent, received, error: timeout ? 'timeout' : error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    return {
      routeId, contractVersion: ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
      targetTopology: snapshot.current?.topology ?? 'single', targetWorkers: snapshot.current?.workerBudget ?? 0,
      confidence: null, reason: timeout ? 'provider_timeout_preserve_current' : 'provider_unavailable_preserve_current',
      providerStatus: 'unavailable', model: null, latencyMs: Date.now() - started,
      inputTokens: null, outputTokens: null, singleSufficient: null, needsOrchestration: null,
    };
  }
}
