import { randomUUID } from 'node:crypto';
import { TYPESAFE_ENDPOINT, TYPESAFE_MODEL, validJevModel } from './adaptive-config.ts';
import type { AdaptiveTopology, AdaptiveTopologyDecision, AdaptiveWorkerCapacity, AdaptiveLockScope } from '../shared/adaptive-topology.ts';
import { parseTopologyPlan, topologyPlanId, validTopologyTarget } from '../shared/adaptive-topology-policy.ts';

/** v3 (#207): one joint `plan` choice replaces v2's independent `target_topology` and `worker_budget` questions. */
export const ADAPTIVE_TOPOLOGY_CONTRACT_VERSION = 'adaptive-routing-v3' as const;
const MAX_RESPONSE_BYTES = 128 * 1024;

/**
 * A specific, local failure class for a Jev call (#207). It never carries a provider body, header or credential:
 * `plan_not_offered`, `plan_contradicts_sufficiency`, `malformed_answer:<question>`, `probabilities_invalid:<question>`,
 * `model_missing`, `missing_usage`, `malformed_response`, `response_too_large`, `request_too_large`, `http_<status>`,
 * `timeout`, `cancelled`, `network`, `invalid_model_setting`, `invalid_timeout`, `invalid_snapshot`, `internal_error`.
 */
export class JevRejection extends Error {
  constructor(readonly code: string) { super(code); this.name = 'JevRejection'; }
}
function ensure(value: unknown, code: string): asserts value {
  if (!value) throw new JevRejection(code);
}
/**
 * Largest worker count offered as a Multi-DM or Multi-Room plan. Every option is sent (and billed) on every call and
 * takes a share of Jev's probability mass, and one brain cannot usefully supervise more parallel workstreams than
 * this. The current multi-worker plan is still offered (as Multi-DM and Multi-Room) when it is feasible above the cap,
 * so the cap alone never pushes a running execution down. The plan question therefore has at most
 * 1 + 1 + 2 * (8 - 1) + 2 = 18 options, far below TypeSafe's 255-option Choice limit.
 */
export const MAX_PLAN_WORKERS = 8;

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
/** Validates one answer. `notOffered` is the code for a well-formed choice outside the offered options. */
function answer(raw: unknown, id: string, type: 'choice' | 'score', options: string[], notOffered = `malformed_answer:${id}`): Answer {
  const malformed = `malformed_answer:${id}`, invalid = `probabilities_invalid:${id}`;
  ensure(raw && typeof raw === 'object' && !Array.isArray(raw), malformed);
  const value = raw as Record<string, unknown>;
  ensure(value.type === type, malformed);
  ensure(probability(value.confidence), malformed);
  if (type === 'choice') {
    ensure(typeof value.choice === 'string', malformed);
    ensure(options.includes(value.choice), notOffered);
  } else ensure(typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= 0 && value.score <= 2, malformed);
  ensure(value.probabilities && typeof value.probabilities === 'object' && !Array.isArray(value.probabilities), invalid);
  const entries = Object.entries(value.probabilities);
  ensure(entries.length === options.length && entries.every(([key]) => options.includes(key)), invalid);
  ensure(entries.every(([, p]) => probability(p)), invalid);
  const distribution = Object.fromEntries(entries) as Record<string, number>;
  ensure(Math.abs(Object.values(distribution).reduce((sum, p) => sum + p, 0) - 1) <= 0.02, invalid);
  if (type === 'choice') ensure(distribution[value.choice as string]! + 1e-9 >= Math.max(...Object.values(distribution)), invalid);
  return { type, confidence: value.confidence, probabilities: distribution,
    ...(type === 'choice' ? { choice: value.choice as string } : { score: value.score as number }) };
}

/**
 * Every feasible plan for the current capacity, as `option id → criteria`. Each option fixes both the topology and
 * the total worker count, so a topology/budget contradiction cannot be expressed.
 */
export function topologyPlans(snapshot: TopologyEvaluationSnapshot): Record<string, string> {
  const usable = snapshot.capacity.workers.usableForExecution;
  ensure(Number.isSafeInteger(usable) && usable >= 0, 'invalid_snapshot');
  const plans: Record<string, string> = {};
  if (!snapshot.execution.orchestratedOnly || usable === 0)
    plans.single = 'Single · the brain alone safely completes the next phase. Zero workers.';
  if (usable >= 1) plans.brain_one_worker = 'Brain + 1 worker · exactly one worker provides useful specialization or delegation.';
  const multi = (workers: number) => {
    plans[topologyPlanId({ topology: 'brain_multi_dm', workers })] =
      `Multi-DM · ${workers} workers in total · ${workers} independent workstreams, each coordinated by the brain through a separate DM.`;
    plans[topologyPlanId({ topology: 'brain_multi_room', workers })] =
      `Multi-Room · ${workers} workers in total · the workers need shared decisions, peer clarification or common coordination state in one room.`;
  };
  for (let workers = 2; workers <= Math.min(usable, MAX_PLAN_WORKERS); workers++) multi(workers);
  const current = snapshot.current;
  if (current && current.workerBudget > MAX_PLAN_WORKERS && validTopologyTarget({ topology: current.topology, workers: current.workerBudget }, usable))
    multi(current.workerBudget);
  // Same rule as contract v2: offered when no worker is usable, or when orchestration is required but only Brain + 1 fits.
  if (usable === 0 || Object.keys(plans).length === 1)
    plans.capacity_blocked = 'The necessary orchestration is not feasible with this capacity. Keep doing safe local work and report missing capacity.';
  return plans;
}

export function topologyQuestions(snapshot: TopologyEvaluationSnapshot) {
  const plans = topologyPlans(snapshot);
  const usable = snapshot.capacity.workers.usableForExecution;
  const questions: Record<string, unknown> = {
    single_agent_sufficiency: { type: 'choice', instructions: 'Can the brain alone safely complete the next phase?', criteria: {
      sufficient: 'One capable session is sufficient.', insufficient: 'Delegation or peer coordination materially benefits quality or completion.',
    } },
    complexity: { type: 'score', instructions: 'How complex is the remaining execution phase?', criteria: ['Bounded local work.', 'Several interacting steps.', 'Broad or highly coupled work.'] },
    parallelizability: { type: 'score', instructions: 'How much useful work can proceed independently now?', criteria: ['Sequential.', 'Some independent work.', 'Several substantial independent workstreams.'] },
    coupling: { type: 'score', instructions: 'How tightly coupled are the remaining workstreams?', criteria: ['Independent.', 'Some synchronization.', 'Shared state or frequent cross-decisions.'] },
    specialization_need: { type: 'score', instructions: 'How much does distinct specialist expertise help the next phase?', criteria: ['Little.', 'Useful.', 'Materially important.'] },
    coordination_need: { type: 'score', instructions: 'How much active coordination between workers is needed?', criteria: ['None.', 'Handoffs and occasional synchronization.', 'Shared decisions or peer clarification.'] },
    plan: { type: 'choice', instructions: {
      question: 'Choose the best feasible plan for the next phase: how the work is organized and how many workers it needs in total. Use only the options below. The worker count includes workers already committed to this execution; do not count them twice. Do not choose specific workers or subtasks.',
      free_workers: snapshot.capacity.workers.free,
      already_committed_to_this_execution: snapshot.capacity.workers.busyCurrent,
      usable_workers: usable,
      human_requires_orchestration: snapshot.execution.orchestratedOnly,
    }, criteria: plans },
  };
  return { questions, plans, usable };
}

async function responseJson(response: Response): Promise<unknown> {
  ensure(response.body, 'malformed_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      ensure(bytes <= MAX_RESPONSE_BYTES, 'response_too_large');
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new JevRejection('malformed_response'); }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function aborted(error: unknown): boolean {
  return error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
}

/** API contract: https://docs.typesafe.ai/api. No SDK, retries or externally supplied endpoint. */
export async function evaluateAdaptiveTopology(
  snapshot: TopologyEvaluationSnapshot,
  /** `model` is the requested identifier (the saved setting); absent means the default alias. */
  config: { apiKey: string; model?: string },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal;
    /** Receives the exact request body (never the key) and the parsed response, for the Human-only call log. */
    onExchange?: (exchange: { sent: unknown | null; received: unknown | null; error: string | null }) => void } = {},
): Promise<AdaptiveTopologyDecision> {
  const routeId = `route-${randomUUID()}`;
  const started = Date.now();
  let sent: unknown | null = null, received: unknown | null = null, responded = false;
  // Kept for every parsable response, including one that is then rejected: those tokens were spent.
  let model: string | null = null, inputTokens: number | null = null, outputTokens: number | null = null;
  const requested = config.model ?? TYPESAFE_MODEL;
  // Never sent unless it is a bounded identifier; the endpoint is fixed regardless of the model.
  const requestedModel = validJevModel(requested) ? requested : null;
  try {
    ensure(requestedModel, 'invalid_model_setting');
    const timeout = options.timeoutMs ?? 2_000;
    ensure(Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 10_000, 'invalid_timeout');
    const { questions, plans, usable } = topologyQuestions(snapshot);
    sent = { state: snapshot, model: requestedModel, questions };
    const body = JSON.stringify(sent);
    ensure(Buffer.byteLength(body) <= 64 * 1024, 'request_too_large');
    const deadline = AbortSignal.timeout(timeout);
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(TYPESAFE_ENDPOINT, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      });
    } catch (error) {
      // A transport message may carry a URL or platform detail: only its class is kept.
      if (aborted(error)) throw error;
      throw new JevRejection('network');
    }
    // An unavailable pinned identifier surfaces as a provider HTTP error: never retried with another model.
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new JevRejection(`http_${response.status}`); }
    const raw = await responseJson(response);
    received = raw; responded = true;
    ensure(raw && typeof raw === 'object' && !Array.isArray(raw), 'malformed_response');
    const envelope = raw as { model?: unknown; answers?: unknown; usage?: unknown };
    if (typeof envelope.model === 'string' && envelope.model.length > 0 && envelope.model.length <= 200) model = envelope.model;
    const usage = (envelope.usage && typeof envelope.usage === 'object' ? envelope.usage : {}) as { input_tokens?: unknown; output_tokens?: unknown };
    if (Number.isSafeInteger(usage.input_tokens) && Number(usage.input_tokens) >= 0 &&
      Number.isSafeInteger(usage.output_tokens) && Number(usage.output_tokens) >= 0) {
      inputTokens = Number(usage.input_tokens); outputTokens = Number(usage.output_tokens);
    }
    ensure(model, 'model_missing');
    ensure(inputTokens !== null && outputTokens !== null, 'missing_usage');
    const a = (envelope.answers && typeof envelope.answers === 'object' ? envelope.answers : {}) as Record<string, unknown>;
    const sufficiency = answer(a.single_agent_sufficiency, 'single_agent_sufficiency', 'choice', ['sufficient', 'insufficient']);
    const scores = ['complexity', 'parallelizability', 'coupling', 'specialization_need', 'coordination_need']
      .map(key => answer(a[key], key, 'score', ['0', '1', '2']));
    const chosen = answer(a.plan, 'plan', 'choice', Object.keys(plans), 'plan_not_offered');
    const plan = parseTopologyPlan(chosen.choice!);
    const blocked = plan === 'capacity_blocked';
    const target = plan === null || blocked ? { topology: 'single' as const, workers: 0 } : plan;
    // Every offered plan is consistent by construction; this only guards the option builder itself.
    ensure(plan !== null && validTopologyTarget(target, usable), 'plan_not_offered');
    const singleSufficient = sufficiency.choice === 'sufficient';
    // "Delegation materially helps" together with a zero-worker plan while workers are usable is not repaired into
    // either reading. The reverse (sufficient, yet a delegating plan) is coherent: delegation can still pay off.
    ensure(blocked || target.topology !== 'single' || singleSufficient || usable === 0, 'plan_contradicts_sufficiency');
    const confidence = Math.min(sufficiency.confidence, chosen.confidence, ...scores.map(s => s.confidence));
    options.onExchange?.({ sent, received, error: null });
    return {
      routeId, contractVersion: ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
      targetTopology: target.topology, targetWorkers: target.workers, confidence,
      reason: blocked ? 'orchestration_needed_no_capacity' : target.topology === 'single' ? 'single_sufficient'
        : target.topology === 'brain_multi_room' ? 'shared_coordination_pressure'
          : target.topology === 'brain_multi_dm' ? 'parallel_workstreams' : 'one_worker_sufficient',
      // The resolved model may differ from the requested one (alias drift); both are kept, neither is rewritten.
      providerStatus: 'ok', requestedModel, model, latencyMs: Date.now() - started,
      inputTokens, outputTokens, singleSufficient, needsOrchestration: blocked || !singleSufficient, error: null,
    };
  } catch (error) {
    // Only local failure classes are kept: never a provider error body or header.
    const code = error instanceof JevRejection ? error.code
      : aborted(error) ? options.signal?.aborted ? 'cancelled' : 'timeout' : 'internal_error';
    options.onExchange?.({ sent, received, error: code });
    return {
      routeId, contractVersion: ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
      targetTopology: snapshot.current?.topology ?? 'single', targetWorkers: snapshot.current?.workerBudget ?? 0,
      confidence: null,
      reason: code === 'timeout' ? 'provider_timeout_preserve_current'
        : responded ? 'response_rejected_preserve_current' : 'provider_unavailable_preserve_current',
      providerStatus: 'unavailable', requestedModel, model, latencyMs: Date.now() - started,
      inputTokens, outputTokens, singleSufficient: null, needsOrchestration: null, error: code,
    };
  }
}
