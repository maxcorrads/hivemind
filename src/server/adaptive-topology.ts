import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Hive } from "./hive.ts";
import { HiveError, HUMAN_ID, type Agent, type Message } from "../shared/types.ts";
import {
  ADAPTIVE_TOPOLOGIES,
  type AdaptiveExecutionState,
  type AdaptiveLockScope,
  type AdaptiveRoutingEvent,
  type AdaptiveRoutingMode,
  type AdaptiveRoutingView,
  type AdaptiveTopology,
  type AdaptiveTopologyDecision,
  type AdaptiveWorkerCapacity,
} from "../shared/adaptive-topology.ts";
import {
  loadAdaptiveRouting,
  TYPESAFE_ENDPOINT,
  TYPESAFE_MODEL,
  type AdaptiveRoutingFile,
} from "./adaptive-routing.ts";

export const ADAPTIVE_TOPOLOGY_CONTRACT_VERSION = "adaptive-routing-v2" as const;
const HIGH_CONFIDENCE = 0.90;
const COOLDOWN_EVENTS = 2;
const MAX_RECENT_EVENTS = 8;
const MAX_ROUTING_EVENTS = 500;

export type AdaptiveCoordinationEvent = {
  kind:
    | "brain_message"
    | "worker_message"
    | "delegation_attempt"
    | "task_event"
    | "room_event"
    | "capacity_change";
  actorId: string;
  actorRole: "brain" | "worker";
  channelId?: string;
  taskId?: string;
  eventType?: string;
  summary?: string;
  workerName?: string;
  usesRoom?: boolean;
};

type StoredExecution = AdaptiveExecutionState & {
  recentEvents: AdaptiveCoordinationEvent[];
};

type HumanMessageInput = {
  channel: string;
  body: string;
  requestId?: string;
  threadId?: string | null;
  eventType?: Message["eventType"];
  traceId?: string;
  causeMessageId?: string;
  attachmentIds?: string[];
  recipients?: string[];
  source?: "hive" | "telegram";
};

type CapacitySnapshot = {
  workers: AdaptiveWorkerCapacity;
  activeTasks: number;
  activeWorkers: number;
  blockers: number;
  openDependencies: number;
  workstreams: number;
};

type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
};

type EvaluationSnapshot = {
  request: string;
  project: { slug: string; name: string };
  current: {
    topology: AdaptiveTopology;
    workerBudget: number;
    desiredTopology: AdaptiveTopology | null;
    desiredWorkers: number | null;
  } | null;
  capacity: CapacitySnapshot;
  execution: {
    orchestratedOnly: boolean;
    lockScope: AdaptiveLockScope;
    lockedTopology: AdaptiveTopology | null;
  };
  tasks: {
    active: number;
    activeWorkers: number;
    blockers: number;
    openDependencies: number;
    workstreams: number;
  };
  recentCoordinationEvents: AdaptiveCoordinationEvent[];
  trigger: AdaptiveCoordinationEvent | { kind: "human_request"; actorId: typeof HUMAN_ID; actorRole: "human"; summary: string };
  previousDecision: AdaptiveTopologyDecision | null;
};

type ConversationLock = { topology: AdaptiveTopology; updatedAt: number };

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function probabilities(value: unknown, label: string): Record<string, number> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}.probabilities required`);
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    assert.ok(finiteProbability(item), `${label}.probabilities must be 0..1`);
    out[key] = item;
  }
  assert.ok(Object.keys(out).length >= 2, `${label}.probabilities needs at least two entries`);
  const sum = Object.values(out).reduce((n, p) => n + p, 0);
  assert.ok(Math.abs(sum - 1) <= 0.02, `${label}.probabilities must sum to 1`);
  return out;
}

function choice(value: unknown, label: string): ChoiceAnswer {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} required`);
  const row = value as Record<string, unknown>;
  assert.equal(row.type, "choice", `${label} must be choice`);
  assert.ok(typeof row.choice === "string" && row.choice.length > 0, `${label}.choice required`);
  assert.ok(finiteProbability(row.confidence), `${label}.confidence must be 0..1`);
  return { type: "choice", choice: row.choice, confidence: row.confidence,
    probabilities: probabilities(row.probabilities, label) };
}

function score(value: unknown, label: string): ScoreAnswer {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} required`);
  const row = value as Record<string, unknown>;
  assert.equal(row.type, "score", `${label} must be score`);
  assert.ok(typeof row.score === "number" && Number.isFinite(row.score) && row.score >= 0 && row.score <= 2,
    `${label}.score must be 0..2`);
  assert.ok(finiteProbability(row.confidence), `${label}.confidence must be 0..1`);
  return { type: "score", score: row.score, confidence: row.confidence,
    probabilities: probabilities(row.probabilities, label) };
}

function rank(topology: AdaptiveTopology): number {
  if (topology === "single") return 0;
  if (topology === "brain_one_worker") return 1;
  if (topology === "brain_multi_dm") return 2;
  return 3;
}

function minimumWorkers(topology: AdaptiveTopology): number {
  if (topology === "single") return 0;
  if (topology === "brain_one_worker") return 1;
  return 2;
}

function normalizeRoutingMode(mode: string | undefined): AdaptiveRoutingMode {
  if (!mode || mode === "auto") return "auto";
  if (mode === "orchestrated") return "orchestrated_auto";
  if (mode === "orchestrated_auto" || ADAPTIVE_TOPOLOGIES.includes(mode as AdaptiveTopology))
    return mode as AdaptiveRoutingMode;
  throw new HiveError(400, "Unknown adaptive routing mode");
}

function normalizeLockScope(scope: string | undefined): AdaptiveLockScope {
  if (!scope || scope === "none") return "none";
  if (scope === "task" || scope === "conversation") return scope;
  throw new HiveError(400, "Unknown adaptive routing lock scope");
}

function topologyFromMode(mode: AdaptiveRoutingMode): AdaptiveTopology | null {
  return ADAPTIVE_TOPOLOGIES.includes(mode as AdaptiveTopology) ? mode as AdaptiveTopology : null;
}

function isEscalation(current: AdaptiveTopology, currentWorkers: number, target: AdaptiveTopology, targetWorkers: number): boolean {
  return rank(target) > rank(current) || (rank(target) === rank(current) && targetWorkers > currentWorkers);
}

function transitionConfirmations(
  current: AdaptiveTopology,
  currentWorkers: number,
  target: AdaptiveTopology,
  targetWorkers: number,
  confidence: number,
): number {
  if (target === "single" && current !== "single") return confidence >= HIGH_CONFIDENCE ? 2 : 3;
  if (isEscalation(current, currentWorkers, target, targetWorkers)) return confidence >= HIGH_CONFIDENCE ? 1 : 2;
  return 2;
}

function reasonFor(topology: AdaptiveTopology, signals: {
  coordination: ScoreAnswer; parallel: ScoreAnswer; specialization: ScoreAnswer; complexity: ScoreAnswer;
}, singleSufficient: boolean): string {
  if (topology === "single") return singleSufficient ? "single_sufficient" : "capacity_limited_single";
  if (topology === "brain_multi_room") return signals.coordination.score >= 1.25 ? "shared_coordination_pressure" : "room_recommended";
  if (topology === "brain_multi_dm") return signals.parallel.score >= 1 ? "parallel_workstreams" : "multi_worker_recommended";
  if (signals.specialization.score >= 1 || signals.complexity.score >= 1) return "specialist_or_complex_work";
  return "one_worker_sufficient";
}

function choiceCriteria(capacity: AdaptiveWorkerCapacity): Record<string, string> {
  const criteria: Record<string, string> = {
    single: "No worker delegation is needed for the next execution phase.",
  };
  if (capacity.usableForExecution >= 1)
    criteria.brain_one_worker = "One worker adds useful leverage; active peer coordination is not required.";
  if (capacity.usableForExecution >= 2) {
    criteria.brain_multi_dm = "Two or more independent worker workstreams are useful; the brain can coordinate through separate task DMs.";
    criteria.brain_multi_room = "Two or more workers need shared state, peer clarification or coordinated decisions in a room.";
  }
  if (capacity.usableForExecution === 0)
    criteria.capacity_blocked = "Orchestration is needed but no worker is currently available; continue locally until capacity changes.";
  return criteria;
}

function budgetCriteria(capacity: AdaptiveWorkerCapacity): Record<string, string> | null {
  if (capacity.usableForExecution === 0) return null;
  const criteria: Record<string, string> = {};
  for (let n = 0; n <= capacity.usableForExecution; n++)
    criteria[`workers_${n}`] = n === 0 ? "No worker is useful now." : `Use at most ${n} worker${n === 1 ? "" : "s"} for the next phase.`;
  return criteria;
}

export async function evaluateAdaptiveTopology(
  snapshot: EvaluationSnapshot,
  config: Pick<AdaptiveRoutingFile, "apiKey">,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AdaptiveTopologyDecision> {
  const routeId = `route-${randomUUID()}`;
  const started = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const topologyChoices = choiceCriteria(snapshot.capacity.workers);
  const budgets = budgetCriteria(snapshot.capacity.workers);
  const questions: Record<string, unknown> = {
    single_agent_sufficiency: {
      type: "choice",
      instructions: "Can one capable brain session safely complete the next phase without worker delegation?",
      criteria: {
        sufficient: "The remaining work is coherent and bounded enough for the brain alone.",
        insufficient: "Worker delegation or shared coordination would materially improve completion or quality.",
      },
    },
    complexity: {
      type: "score",
      instructions: "How structurally complex is the next phase?",
      criteria: ["bounded/local", "several interacting steps", "broad or highly interacting work"],
    },
    parallelizability: {
      type: "score",
      instructions: "How much useful independent work can proceed concurrently now?",
      criteria: ["mostly sequential", "some parallel work", "multiple strong independent workstreams"],
    },
    coupling: {
      type: "score",
      instructions: "How tightly coupled are the workstreams and decisions now?",
      criteria: ["mostly independent", "some synchronization", "shared state/frequent peer coordination"],
    },
    specialization_need: {
      type: "score",
      instructions: "How much would distinct worker specialization improve the next phase?",
      criteria: ["little", "useful", "materially important"],
    },
    coordination_need: {
      type: "score",
      instructions: "How much active coordination among multiple workers is needed now?",
      criteria: ["none", "some handoff/synchronization", "shared decisions or peer clarification"],
    },
    target_topology: {
      type: "choice",
      instructions: [
        "Choose the best feasible execution topology for the next phase.",
        `There are ${snapshot.capacity.workers.free} free workers and ${snapshot.capacity.workers.busyCurrent} workers already committed to this execution.`,
        `Never choose a topology requiring more than ${snapshot.capacity.workers.usableForExecution} total workers available to this execution.`,
        snapshot.execution.orchestratedOnly
          ? "Human already required orchestration: choose an orchestrated topology whenever worker capacity permits."
          : "Single is valid when it is sufficient.",
      ].join(" "),
      criteria: topologyChoices,
    },
  };
  if (budgets) questions.worker_budget = {
    type: "choice",
    instructions: `Choose how many total workers should be committed to the next phase. Maximum ${snapshot.capacity.workers.usableForExecution}. This is a budget; Hivemind/brain chooses specific workers.`,
    criteria: budgets,
  };

  try {
    const response = await fetchImpl(TYPESAFE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: snapshot, model: TYPESAFE_MODEL, questions }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const payload = await response.json() as {
      model?: unknown;
      answers?: Record<string, unknown>;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    assert.ok(typeof payload.model === "string" && payload.model.length > 0, "Jev model required");
    assert.ok(Number.isSafeInteger(payload.usage?.input_tokens) && Number(payload.usage!.input_tokens) >= 0, "Invalid input token usage");
    assert.ok(Number.isSafeInteger(payload.usage?.output_tokens) && Number(payload.usage!.output_tokens) >= 0, "Invalid output token usage");
    const answers = payload.answers ?? {};
    const sufficient = choice(answers.single_agent_sufficiency, "single_agent_sufficiency");
    const complexity = score(answers.complexity, "complexity");
    const parallel = score(answers.parallelizability, "parallelizability");
    const coupling = score(answers.coupling, "coupling");
    const specialization = score(answers.specialization_need, "specialization_need");
    const coordination = score(answers.coordination_need, "coordination_need");
    const topologyAnswer = choice(answers.target_topology, "target_topology");
    assert.ok(Object.hasOwn(topologyChoices, topologyAnswer.choice), "Jev selected unavailable topology");
    const budgetAnswer = budgets ? choice(answers.worker_budget, "worker_budget") : null;
    if (budgetAnswer) assert.ok(Object.hasOwn(budgets!, budgetAnswer.choice), "Jev selected unavailable worker budget");

    const singleSufficient = sufficient.choice === "sufficient";
    const needsOrchestration = !singleSufficient;
    let targetTopology: AdaptiveTopology =
      topologyAnswer.choice === "capacity_blocked" ? "single" : topologyAnswer.choice as AdaptiveTopology;
    let targetWorkers = budgetAnswer ? Number(budgetAnswer.choice.replace(/^workers_/, "")) : 0;
    const maxWorkers = snapshot.capacity.workers.usableForExecution;
    if (targetTopology === "single") targetWorkers = 0;
    else if (targetTopology === "brain_one_worker") targetWorkers = 1;
    else targetWorkers = Math.max(2, Math.min(maxWorkers, Number.isFinite(targetWorkers) ? targetWorkers : 2));

    const confidences = [sufficient, complexity, parallel, coupling, specialization, coordination, topologyAnswer,
      ...(budgetAnswer ? [budgetAnswer] : [])].map(answer => answer.confidence);
    const confidence = Math.min(...confidences);
    return {
      routeId,
      contractVersion: ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
      targetTopology,
      targetWorkers,
      confidence,
      reason: topologyAnswer.choice === "capacity_blocked"
        ? "orchestration_needed_no_capacity"
        : reasonFor(targetTopology, { coordination, parallel, specialization, complexity }, singleSufficient),
      providerStatus: "ok",
      model: payload.model,
      latencyMs: Date.now() - started,
      inputTokens: Number(payload.usage!.input_tokens),
      outputTokens: Number(payload.usage!.output_tokens),
      singleSufficient,
      needsOrchestration,
    };
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      routeId,
      contractVersion: ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
      targetTopology: snapshot.current?.topology ?? "single",
      targetWorkers: snapshot.current?.workerBudget ?? 0,
      confidence: null,
      reason: timeout ? "provider_timeout_preserve_current" : "provider_unavailable_preserve_current",
      providerStatus: "unavailable",
      model: null,
      latencyMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
      singleSufficient: null,
      needsOrchestration: null,
    };
  }
}

function stateForView(stored: StoredExecution): AdaptiveExecutionState {
  const { recentEvents: _recentEvents, ...state } = stored;
  return state;
}

function cleanSummary(value: string | undefined): string | undefined {
  const text = value?.trim().replace(/\s+/g, " ");
  return text ? text.slice(0, 400) : undefined;
}

export function topologyDirective(state: Pick<AdaptiveExecutionState,
  "executionId" | "currentTopology" | "workerBudget" | "lockScope" | "orchestratedOnly">): string {
  const lock = state.lockScope === "none" ? "" : ` Human lock: ${state.lockScope}.`;
  if (state.currentTopology === "single") return [
    `[Hivemind adaptive topology · SINGLE · ${state.executionId}]`,
    "Execute this Human request in the current brain session. Do not delegate new work while Single is active.",
    "Hivemind continuously revalidates Jev at coordination boundaries and will gate any delegation attempt before it occurs.",
    lock,
  ].filter(Boolean).join("\n");
  if (state.currentTopology === "brain_one_worker") return [
    `[Hivemind adaptive topology · BRAIN+1 · ${state.executionId}]`,
    "Coordinate with at most one worker for this request. Prefer a structured task/DM; do not create new room work.",
    "The server continuously revalidates topology and enforces the worker budget at delegation boundaries.",
    lock,
  ].filter(Boolean).join("\n");
  if (state.currentTopology === "brain_multi_dm") return [
    `[Hivemind adaptive topology · MULTI-DM · ${state.workerBudget} workers · ${state.executionId}]`,
    `Use up to ${state.workerBudget} workers through separate structured tasks/DMs. Do not create new room work unless the enforced topology changes.`,
    "The brain still decides decomposition and specific workers.",
    lock,
  ].filter(Boolean).join("\n");
  return [
    `[Hivemind adaptive topology · ROOM · ${state.workerBudget} workers · ${state.executionId}]`,
    `Coordinate new delegated work through a room with up to ${state.workerBudget} workers. Existing non-room work may finish, but new work should follow the room contract.`,
    "The brain decides decomposition and specific workers; use the following Human request as authorization evidence when configuring the room.",
    lock,
  ].filter(Boolean).join("\n");
}

export class AdaptiveTopologyRuntime {
  private serial = new Map<string, Promise<unknown>>();

  constructor(private hive: Hive) {
    this.hive.db.exec(`
      CREATE TABLE IF NOT EXISTS adaptive_topology_executions (
        channel_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        brain_id TEXT NOT NULL,
        root_message_id TEXT NOT NULL,
        snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_adaptive_topology_brain ON adaptive_topology_executions(brain_id, project_id);
      CREATE TABLE IF NOT EXISTS adaptive_topology_events (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_adaptive_topology_events_channel ON adaptive_topology_events(channel_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS adaptive_topology_locks (
        channel_id TEXT PRIMARY KEY,
        topology TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.hive.bus.on("agent", (agent: Agent) => {
      if (agent.role !== "worker" || !agent.projectId) return;
      void this.revalidateProject(agent.projectId, {
        kind: "capacity_change", actorId: agent.id, actorRole: "worker",
        summary: `${agent.name} is now ${agent.online ? "online" : "offline"}`,
      }).catch(() => undefined);
    });
  }

  private queued<T>(channelId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(channelId) ?? Promise.resolve();
    const next = previous.then(op, op);
    const fence = next.finally(() => {
      if (this.serial.get(channelId) === fence) this.serial.delete(channelId);
    });
    this.serial.set(channelId, fence);
    return next;
  }

  private row(channelId: string): StoredExecution | null {
    const row = this.hive.db.prepare("SELECT snapshot FROM adaptive_topology_executions WHERE channel_id=?")
      .get(channelId) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as StoredExecution : null;
  }

  private save(state: StoredExecution): void {
    this.hive.db.prepare(`INSERT INTO adaptive_topology_executions
      (channel_id,execution_id,project_id,brain_id,root_message_id,snapshot) VALUES(?,?,?,?,?,?)
      ON CONFLICT(channel_id) DO UPDATE SET execution_id=excluded.execution_id,project_id=excluded.project_id,
      brain_id=excluded.brain_id,root_message_id=excluded.root_message_id,snapshot=excluded.snapshot`)
      .run(state.channelId, state.executionId, state.projectId, state.brainId, state.rootMessageId, JSON.stringify(state));
  }

  private conversationLock(channelId: string): ConversationLock | null {
    const row = this.hive.db.prepare("SELECT topology,updated_at AS updatedAt FROM adaptive_topology_locks WHERE channel_id=?")
      .get(channelId) as { topology: string; updatedAt: number } | undefined;
    if (!row || !ADAPTIVE_TOPOLOGIES.includes(row.topology as AdaptiveTopology)) return null;
    return { topology: row.topology as AdaptiveTopology, updatedAt: row.updatedAt };
  }

  private setConversationLock(channelId: string, topology: AdaptiveTopology | null): void {
    if (!topology) {
      this.hive.db.prepare("DELETE FROM adaptive_topology_locks WHERE channel_id=?").run(channelId);
      return;
    }
    this.hive.db.prepare(`INSERT INTO adaptive_topology_locks(channel_id,topology,updated_at) VALUES(?,?,?)
      ON CONFLICT(channel_id) DO UPDATE SET topology=excluded.topology,updated_at=excluded.updated_at`)
      .run(channelId, topology, Date.now());
  }

  private brainForChannel(channelId: string): Agent {
    const channel = this.hive.getChannel(channelId);
    const brains = channel.memberIds.map(id => this.hive.getAgent(id)).filter(agent => agent.role === "brain");
    if (channel.type !== "dm" || brains.length !== 1) throw new HiveError(400, "Adaptive topology requires a Human-to-brain DM");
    return brains[0]!;
  }

  private routingRequestBody(state: StoredExecution): string {
    const message = this.hive.getMessageById(state.rootMessageId);
    const body = message.body;
    return message.source === "telegram" ? body.replace(/^\[[^\]]{1,40}\]\s*/, "") : body;
  }

  private taskRows(projectId: string): Array<{ snapshot: string }> {
    return this.hive.db.prepare(`SELECT t.snapshot FROM task_records t JOIN channels c ON c.id=t.channel_id
      WHERE c.project_id=?`).all(projectId) as Array<{ snapshot: string }>;
  }

  private capacity(state: Pick<StoredExecution, "projectId" | "brainId">): CapacitySnapshot {
    const workers = this.hive.listAgents().filter(agent => agent.role === "worker" && agent.projectId === state.projectId);
    const tasks = this.taskRows(state.projectId).map(row => JSON.parse(row.snapshot) as {
      id: string; assignerId: string; workerId: string; state: string; contract?: { dependencies?: string[] };
    });
    const active = tasks.filter(task => !["accepted_complete", "rejected"].includes(task.state));
    const currentTasks = active.filter(task => task.assignerId === state.brainId);
    const currentBusy = new Set(currentTasks.map(task => task.workerId));
    const otherBusy = new Set(active.filter(task => task.assignerId !== state.brainId).map(task => task.workerId));
    const free = workers.filter(worker => worker.online && !currentBusy.has(worker.id) && !otherBusy.has(worker.id));
    const committed = workers.filter(worker => worker.online && currentBusy.has(worker.id) && !otherBusy.has(worker.id));
    const available = [...committed.map(worker => ({ ...worker, committed: true })), ...free.map(worker => ({ ...worker, committed: false }))]
      .map(worker => ({ id: worker.id, name: worker.name, seniority: worker.seniority, focus: worker.focus, committed: worker.committed }));
    const states = new Map(tasks.map(task => [task.id, task.state]));
    let openDependencies = 0;
    for (const task of currentTasks)
      for (const dep of task.contract?.dependencies ?? [])
        if (states.get(dep) !== "accepted_complete") openDependencies++;
    return {
      workers: {
        total: workers.length,
        online: workers.filter(worker => worker.online).length,
        busyOther: workers.filter(worker => otherBusy.has(worker.id)).length,
        busyCurrent: committed.length,
        free: free.length,
        usableForExecution: available.length,
        available,
      },
      activeTasks: currentTasks.length,
      activeWorkers: new Set(currentTasks.map(task => task.workerId)).size,
      blockers: currentTasks.filter(task => task.state === "blocked").length,
      openDependencies,
      workstreams: Math.max(currentTasks.length, new Set(currentTasks.map(task => task.workerId)).size),
    };
  }

  private snapshot(state: StoredExecution, event: AdaptiveCoordinationEvent, capacity = this.capacity(state)): EvaluationSnapshot {
    const project = this.hive.getProject(state.projectId);
    return {
      request: this.routingRequestBody(state),
      project: { slug: project.slug, name: project.name },
      current: {
        topology: state.currentTopology,
        workerBudget: state.workerBudget,
        desiredTopology: state.desiredTopology,
        desiredWorkers: state.desiredWorkers,
      },
      capacity,
      execution: {
        orchestratedOnly: state.orchestratedOnly,
        lockScope: state.lockScope,
        lockedTopology: state.lockedTopology,
      },
      tasks: {
        active: capacity.activeTasks,
        activeWorkers: capacity.activeWorkers,
        blockers: capacity.blockers,
        openDependencies: capacity.openDependencies,
        workstreams: capacity.workstreams,
      },
      recentCoordinationEvents: state.recentEvents,
      trigger: event,
      previousDecision: state.recommendation,
    };
  }

  private initialSnapshot(
    channelId: string,
    request: string,
    brain: Agent,
    orchestratedOnly: boolean,
    lockScope: AdaptiveLockScope,
    lockedTopology: AdaptiveTopology | null,
  ): EvaluationSnapshot {
    const project = this.hive.getProject(brain.projectId!);
    const capacity = this.capacity({ projectId: project.id, brainId: brain.id });
    return {
      request,
      project: { slug: project.slug, name: project.name },
      current: null,
      capacity,
      execution: { orchestratedOnly, lockScope, lockedTopology },
      tasks: {
        active: capacity.activeTasks,
        activeWorkers: capacity.activeWorkers,
        blockers: capacity.blockers,
        openDependencies: capacity.openDependencies,
        workstreams: capacity.workstreams,
      },
      recentCoordinationEvents: [],
      trigger: { kind: "human_request", actorId: HUMAN_ID, actorRole: "human", summary: request.slice(0, 400) },
      previousDecision: null,
    };
  }

  private feasibleFallback(config: AdaptiveRoutingFile, capacity: AdaptiveWorkerCapacity): AdaptiveTopology {
    const wanted = config.topologyFallback;
    if (wanted === "brain_one_worker" && capacity.usableForExecution >= 1) return wanted;
    if ((wanted === "brain_multi_dm" || wanted === "brain_multi_room") && capacity.usableForExecution >= 2) return wanted;
    if (capacity.usableForExecution >= 1) return "brain_one_worker";
    return "single";
  }

  private budget(topology: AdaptiveTopology, recommended: number, capacity: AdaptiveWorkerCapacity): number {
    if (topology === "single") return 0;
    if (topology === "brain_one_worker") return 1;
    return Math.max(2, Math.min(capacity.usableForExecution, recommended || 2));
  }

  private eventObject(
    state: StoredExecution,
    kind: AdaptiveRoutingEvent["kind"],
    decision: AdaptiveTopologyDecision,
    applied: boolean,
    warning: string | null,
    fromTopology: AdaptiveTopology,
  ): AdaptiveRoutingEvent {
    return {
      id: randomUUID(),
      executionId: state.executionId,
      channelId: state.channelId,
      projectId: state.projectId,
      createdAt: Date.now(),
      kind,
      fromTopology,
      targetTopology: decision.targetTopology,
      appliedTopology: state.currentTopology,
      targetWorkers: decision.targetWorkers,
      appliedWorkers: state.workerBudget,
      confidence: decision.confidence,
      reason: decision.reason,
      providerStatus: decision.providerStatus,
      applied,
      warning,
    };
  }

  private persistEvent(event: AdaptiveRoutingEvent): void {
    this.hive.db.prepare(`INSERT INTO adaptive_topology_events
      (id,execution_id,channel_id,project_id,created_at,snapshot) VALUES(?,?,?,?,?,?)`)
      .run(event.id, event.executionId, event.channelId, event.projectId, event.createdAt, JSON.stringify(event));
    this.hive.db.prepare(`DELETE FROM adaptive_topology_events WHERE channel_id=? AND id NOT IN (
      SELECT id FROM adaptive_topology_events WHERE channel_id=? ORDER BY created_at DESC LIMIT ?)`)
      .run(event.channelId, event.channelId, MAX_ROUTING_EVENTS);
  }

  private publish(event: AdaptiveRoutingEvent, state: StoredExecution): void {
    this.hive.bus.emit("adaptive-routing", { channelId: state.channelId, event, state: stateForView(state) });
  }

  private recent(state: StoredExecution, event: AdaptiveCoordinationEvent): AdaptiveCoordinationEvent[] {
    const next = [...state.recentEvents, { ...event, summary: cleanSummary(event.summary) }];
    return next.slice(-MAX_RECENT_EVENTS);
  }

  private resolveState(actor: Agent, event?: AdaptiveCoordinationEvent): StoredExecution | null {
    if (!actor.projectId) return null;
    let brainId: string | null = actor.role === "brain" ? actor.id : null;
    if (!brainId && event?.taskId) {
      const row = this.hive.db.prepare("SELECT snapshot FROM task_records WHERE id=?").get(event.taskId) as { snapshot: string } | undefined;
      if (row) brainId = String((JSON.parse(row.snapshot) as { assignerId?: string }).assignerId ?? "") || null;
    }
    if (!brainId && event?.channelId) {
      try {
        const channel = this.hive.getChannel(event.channelId, actor.projectId);
        const brain = channel.memberIds.map(id => this.hive.getAgent(id)).find(agent => agent.role === "brain");
        if (brain) brainId = brain.id;
      } catch { /* no execution context */ }
    }
    if (!brainId && actor.role === "worker") {
      const row = this.hive.db.prepare(`SELECT json_extract(snapshot,'$.assignerId') AS brainId FROM task_records
        WHERE worker_id=? AND json_extract(snapshot,'$.state') NOT IN ('accepted_complete','rejected')
        ORDER BY json_extract(snapshot,'$.updatedAt') DESC LIMIT 1`).get(actor.id) as { brainId: string } | undefined;
      brainId = row?.brainId ?? null;
    }
    if (!brainId) return null;
    const row = this.hive.db.prepare(`SELECT snapshot FROM adaptive_topology_executions
      WHERE brain_id=? AND project_id=? ORDER BY json_extract(snapshot,'$.updatedAt') DESC LIMIT 1`)
      .get(brainId, actor.projectId) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as StoredExecution : null;
  }

  private async evaluateWithCapacityRace(state: StoredExecution, event: AdaptiveCoordinationEvent, config: AdaptiveRoutingFile) {
    const firstCapacity = this.capacity(state);
    let decision = await evaluateAdaptiveTopology(this.snapshot(state, event, firstCapacity), config);
    if (decision.providerStatus !== "ok") return { decision, capacity: firstCapacity };
    const currentCapacity = this.capacity(state);
    if (decision.targetWorkers <= currentCapacity.workers.usableForExecution) return { decision, capacity: currentCapacity };
    decision = await evaluateAdaptiveTopology(this.snapshot(state, event, currentCapacity), config);
    return { decision, capacity: this.capacity(state) };
  }

  private normalizeDecision(
    state: StoredExecution,
    decision: AdaptiveTopologyDecision,
    capacity: CapacitySnapshot,
    config: AdaptiveRoutingFile,
  ): AdaptiveTopologyDecision {
    if (decision.providerStatus !== "ok") return decision;
    let target = decision.targetTopology;
    if ((state.orchestratedOnly || decision.needsOrchestration) && target === "single" &&
      capacity.workers.usableForExecution > 0) target = this.feasibleFallback(config, capacity.workers);
    const workers = this.budget(target, decision.targetWorkers, capacity.workers);
    return target === decision.targetTopology && workers === decision.targetWorkers ? decision : {
      ...decision,
      targetTopology: target,
      targetWorkers: workers,
      reason: state.orchestratedOnly ? "orchestrated_only_policy" : "insufficient_single_policy",
    };
  }

  private safeFor(state: StoredExecution, target: AdaptiveTopology, workers: number, capacity: CapacitySnapshot): boolean {
    if (workers > capacity.workers.usableForExecution) return false;
    if (workers < capacity.activeWorkers) return false;
    if (target === "single")
      return capacity.activeTasks === 0 && capacity.blockers === 0 && capacity.openDependencies === 0;
    return workers >= minimumWorkers(target);
  }

  private async revalidateStored(state: StoredExecution, event: AdaptiveCoordinationEvent): Promise<StoredExecution> {
    const config = loadAdaptiveRouting(this.hive.home);
    if (!config?.enabled) return state;
    state.recentEvents = this.recent(state, event);
    const fromTopology = state.currentTopology;
    const { decision: rawDecision, capacity } = await this.evaluateWithCapacityRace(state, event, config);
    const decision = this.normalizeDecision(state, rawDecision, capacity, config);
    state.recommendation = decision;
    state.updatedAt = Date.now();

    if (decision.providerStatus !== "ok") {
      state.providerAvailable = false;
      state.warning = "Jev unavailable · execution mode is not being revalidated";
      state.confirmations = 0;
      state.confirmationTopology = null;
      state.confirmationWorkers = null;
      state.eventsSinceChange++;
      this.save(state);
      const warning = this.eventObject(state, "warning", decision, false, state.warning, fromTopology);
      this.persistEvent(warning); this.publish(warning, state);
      return state;
    }

    state.providerAvailable = true;
    state.warning = null;

    if (state.lockScope !== "none" && state.lockedTopology) {
      state.confirmations = 0;
      state.confirmationTopology = null;
      state.confirmationWorkers = null;
      state.eventsSinceChange++;
      this.save(state);
      const eventRow = this.eventObject(state, "evaluation", decision, false, null, fromTopology);
      this.persistEvent(eventRow); this.publish(eventRow, state);
      return state;
    }

    if (state.orchestratedOnly && decision.targetTopology === "single" &&
      capacity.workers.usableForExecution === 0 && decision.needsOrchestration) {
      state.desiredTopology = config.topologyFallback;
      state.desiredWorkers = minimumWorkers(config.topologyFallback);
      state.warning = "Orchestration needed · no workers available";
      state.confirmations = 0;
      state.eventsSinceChange++;
      this.save(state);
      const eventRow = this.eventObject(state, "warning", decision, false, state.warning, fromTopology);
      this.persistEvent(eventRow); this.publish(eventRow, state);
      return state;
    }

    const same = decision.targetTopology === state.currentTopology && decision.targetWorkers === state.workerBudget;
    if (same) {
      state.confirmations = 0;
      state.confirmationTopology = null;
      state.confirmationWorkers = null;
      state.desiredTopology = null;
      state.desiredWorkers = null;
      state.eventsSinceChange++;
      this.save(state);
      const eventRow = this.eventObject(state, "evaluation", decision, false, null, fromTopology);
      this.persistEvent(eventRow); this.publish(eventRow, state);
      return state;
    }

    if (state.confirmationTopology === decision.targetTopology && state.confirmationWorkers === decision.targetWorkers)
      state.confirmations++;
    else {
      state.confirmationTopology = decision.targetTopology;
      state.confirmationWorkers = decision.targetWorkers;
      state.confirmations = 1;
    }

    const needed = transitionConfirmations(
      state.currentTopology, state.workerBudget, decision.targetTopology, decision.targetWorkers, decision.confidence ?? 0,
    );
    const cooldownReady = state.eventsSinceChange >= COOLDOWN_EVENTS;
    const confirmed = state.confirmations >= needed;
    if (cooldownReady && confirmed) {
      if (this.safeFor(state, decision.targetTopology, decision.targetWorkers, capacity)) {
        state.currentTopology = decision.targetTopology;
        state.workerBudget = decision.targetWorkers;
        state.desiredTopology = null;
        state.desiredWorkers = null;
        state.confirmations = 0;
        state.confirmationTopology = null;
        state.confirmationWorkers = null;
        state.eventsSinceChange = 0;
        this.save(state);
        const transition = this.eventObject(state, "transition", decision, true, null, fromTopology);
        this.persistEvent(transition); this.publish(transition, state);
        return state;
      }
      state.desiredTopology = decision.targetTopology;
      state.desiredWorkers = decision.targetWorkers;
    }
    state.eventsSinceChange++;
    this.save(state);
    const evaluation = this.eventObject(state, "evaluation", decision, false, null, fromTopology);
    this.persistEvent(evaluation); this.publish(evaluation, state);
    return state;
  }

  async revalidateForActor(actor: Agent, event: AdaptiveCoordinationEvent): Promise<AdaptiveExecutionState | null> {
    const state = this.resolveState(actor, event);
    if (!state) return null;
    const updated = await this.queued(state.channelId, () => this.revalidateStored(this.row(state.channelId) ?? state, event));
    return stateForView(updated);
  }

  private async revalidateProject(projectId: string, event: AdaptiveCoordinationEvent): Promise<void> {
    const rows = this.hive.db.prepare("SELECT snapshot FROM adaptive_topology_executions WHERE project_id=?")
      .all(projectId) as Array<{ snapshot: string }>;
    for (const row of rows) {
      const state = JSON.parse(row.snapshot) as StoredExecution;
      await this.queued(state.channelId, () => this.revalidateStored(this.row(state.channelId) ?? state, event));
    }
  }

  private activeWorkerIds(state: StoredExecution): Set<string> {
    const rows = this.hive.db.prepare(`SELECT worker_id FROM task_records
      WHERE json_extract(snapshot,'$.assignerId')=? AND json_extract(snapshot,'$.state') NOT IN ('accepted_complete','rejected')`)
      .all(state.brainId) as Array<{ worker_id: string }>;
    return new Set(rows.map(row => row.worker_id));
  }

  private assertDelegation(state: StoredExecution, event: AdaptiveCoordinationEvent): void {
    if (event.kind !== "delegation_attempt") return;
    if (state.desiredTopology && (rank(state.desiredTopology) < rank(state.currentTopology) ||
      (state.desiredTopology === state.currentTopology && (state.desiredWorkers ?? state.workerBudget) < state.workerBudget)))
      throw new HiveError(409, `Adaptive de-escalation to ${state.desiredTopology} is pending; do not start new delegated work`);
    if (state.currentTopology === "single")
      throw new HiveError(409, "Adaptive routing retains Single; delegation is blocked until Jev selects an orchestrated topology");
    if (state.currentTopology !== "brain_multi_room" && event.usesRoom)
      throw new HiveError(409, `Current adaptive topology is ${state.currentTopology}; new room work is not allowed`);
    if (state.currentTopology === "brain_multi_room" && event.usesRoom === false)
      throw new HiveError(409, "Current adaptive topology is Room; new delegated work must use the room contract");
    const worker = event.workerName ? this.hive.getAgentByName(event.workerName) : null;
    const active = this.activeWorkerIds(state);
    if (worker && !active.has(worker.id)) {
      if (active.size >= state.workerBudget)
        throw new HiveError(409, `Adaptive worker budget is ${state.workerBudget}; finish/reconcile current work before adding another worker`);
      const capacity = this.capacity(state).workers;
      if (!capacity.available.some(candidate => candidate.id === worker.id))
        throw new HiveError(409, `${worker.name} is not free for this adaptive execution; re-evaluate capacity`);
    }
  }

  async beforeBrainAction(actor: Agent, event: AdaptiveCoordinationEvent): Promise<AdaptiveExecutionState | null> {
    if (actor.role !== "brain") return null;
    const state = await this.revalidateForActor(actor, event);
    if (!state) return null;
    const stored = this.row(state.channelId);
    if (stored) this.assertDelegation(stored, event);
    return state;
  }

  async afterAgentAction(actor: Agent, event: AdaptiveCoordinationEvent): Promise<AdaptiveExecutionState | null> {
    if (actor.role !== "brain" && actor.role !== "worker") return null;
    return this.revalidateForActor(actor, event);
  }

  async routeHumanRequest(
    human: Agent,
    input: HumanMessageInput,
    rawMode: string | undefined,
    rawLockScope: string | undefined,
    persistReceipt?: (message: Message) => void,
    routingText?: string,
  ): Promise<{ message: Message; routingMessage: Message; routing: AdaptiveTopologyDecision; state: AdaptiveExecutionState } | null> {
    if (human.role !== "human") throw new HiveError(403, "Only Human starts adaptive topology execution");
    const channel = this.hive.getChannel(input.channel);
    const brain = this.brainForChannel(channel.id);
    const config = loadAdaptiveRouting(this.hive.home);
    const mode = normalizeRoutingMode(rawMode);
    const lockScope = normalizeLockScope(rawLockScope);
    const manualTopology = topologyFromMode(mode);
    if (!config?.enabled && mode === "auto") return null;
    if (lockScope !== "none" && !manualTopology)
      throw new HiveError(400, "Task/conversation locks require an explicit topology");

    const existingConversationLock = this.conversationLock(channel.id);
    const inheritedLock: AdaptiveTopology | null =
      manualTopology ? null : existingConversationLock?.topology ?? null;
    const lockedTopology = manualTopology && lockScope !== "none" ? manualTopology : inheritedLock ?? null;
    const effectiveLockScope: AdaptiveLockScope =
      manualTopology && lockScope !== "none" ? lockScope : inheritedLock ? "conversation" : "none";
    const orchestratedOnly = mode === "orchestrated_auto";
    const initialSnapshot = this.initialSnapshot(
      channel.id, routingText ?? input.body, brain, orchestratedOnly, effectiveLockScope, lockedTopology,
    );
    const capacity = initialSnapshot.capacity.workers;
    let decision: AdaptiveTopologyDecision;
    if (config?.enabled) decision = await evaluateAdaptiveTopology(initialSnapshot, config);
    else decision = {
      routeId: `route-${randomUUID()}`,
      contractVersion: ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
      targetTopology: manualTopology ?? "single",
      targetWorkers: 0,
      confidence: null,
      reason: "jev_disabled_manual_override",
      providerStatus: "bypassed",
      model: null,
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      singleSufficient: null,
      needsOrchestration: null,
    };

    let actualTopology: AdaptiveTopology;
    if (lockedTopology) actualTopology = lockedTopology;
    else if (manualTopology) actualTopology = manualTopology;
    else if (decision.providerStatus === "ok") {
      actualTopology = decision.targetTopology;
      if ((orchestratedOnly || decision.needsOrchestration) && actualTopology === "single" && capacity.usableForExecution > 0)
        actualTopology = this.feasibleFallback(config!, capacity);
    } else {
      actualTopology = config?.fallback === "single" ? "single" : this.feasibleFallback(config!, capacity);
    }

    const required = minimumWorkers(actualTopology);
    if (manualTopology && capacity.usableForExecution < required)
      throw new HiveError(409, `${manualTopology} requires ${required} free/current worker(s); only ${capacity.usableForExecution} are available`);

    let workerBudget = this.budget(actualTopology, decision.targetWorkers, capacity);
    let desiredTopology: AdaptiveTopology | null = null;
    let desiredWorkers: number | null = null;
    let warning: string | null = null;
    if (capacity.usableForExecution < required) {
      desiredTopology = actualTopology;
      desiredWorkers = required;
      actualTopology = "single";
      workerBudget = 0;
      warning = `Locked ${desiredTopology} is waiting for worker capacity`;
    } else if (orchestratedOnly && actualTopology === "single" && decision.needsOrchestration) {
      desiredTopology = config!.topologyFallback;
      desiredWorkers = minimumWorkers(config!.topologyFallback);
      warning = "Orchestration needed · no workers available";
    } else if (decision.providerStatus === "unavailable") {
      warning = "Jev unavailable · initial topology used fallback";
    }

    const executionId = decision.routeId;
    const now = Date.now();
    const stateSeed: Omit<StoredExecution, "rootMessageId"> = {
      executionId,
      channelId: channel.id,
      projectId: channel.projectId,
      brainId: brain.id,
      currentTopology: actualTopology,
      workerBudget,
      desiredTopology,
      desiredWorkers,
      lockScope: effectiveLockScope,
      lockedTopology,
      orchestratedOnly,
      providerAvailable: decision.providerStatus !== "unavailable",
      warning,
      recommendation: decision,
      confirmations: 0,
      confirmationTopology: null,
      confirmationWorkers: null,
      eventsSinceChange: 0,
      updatedAt: now,
      recentEvents: [],
    };

    if (manualTopology && lockScope === "conversation") this.setConversationLock(channel.id, manualTopology);

    let persistedState!: StoredExecution;
    let initialEvent!: AdaptiveRoutingEvent;
    const directiveState = { ...stateSeed, rootMessageId: "" } as StoredExecution;
    const delivered = this.hive.postAdaptiveRequest(
      human,
      input,
      topologyDirective(stateForView(directiveState)),
      `adaptive-${executionId}`,
      persistReceipt,
      (message) => {
        persistedState = { ...stateSeed, rootMessageId: message.id };
        this.save(persistedState);
        initialEvent = this.eventObject(
          persistedState,
          decision.providerStatus === "unavailable" || warning ? "warning" : "evaluation",
          decision,
          actualTopology === decision.targetTopology,
          warning,
          actualTopology,
        );
        this.persistEvent(initialEvent);
      },
    );
    this.publish(initialEvent, persistedState);
    return { ...delivered, routing: decision, state: stateForView(persistedState) };
  }

  view(actor: Agent, channelId: string): AdaptiveRoutingView {
    if (actor.role !== "human") throw new HiveError(403, "Adaptive routing timeline is Human-only");
    const channel = this.hive.getChannel(channelId);
    if (!this.hive.canSeeChannel(actor, channel)) throw new HiveError(403, "Cannot read routing state");
    const state = this.row(channel.id);
    const rows = this.hive.db.prepare(`SELECT snapshot FROM adaptive_topology_events
      WHERE channel_id=? ORDER BY created_at DESC LIMIT 100`).all(channel.id) as Array<{ snapshot: string }>;
    return { state: state ? stateForView(state) : null, events: rows.map(row => JSON.parse(row.snapshot) as AdaptiveRoutingEvent).reverse() };
  }

  forAgent(actor: Agent): AdaptiveExecutionState | null {
    const state = this.resolveState(actor);
    return state ? stateForView(state) : null;
  }

  setLock(actor: Agent, channelId: string, raw: unknown): AdaptiveRoutingView {
    if (actor.role !== "human") throw new HiveError(403, "Only Human changes adaptive routing locks");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HiveError(400, "Expected lock settings");
    const input = raw as { scope?: unknown; topology?: unknown };
    const scope = normalizeLockScope(typeof input.scope === "string" ? input.scope : undefined);
    const topology = typeof input.topology === "string" && ADAPTIVE_TOPOLOGIES.includes(input.topology as AdaptiveTopology)
      ? input.topology as AdaptiveTopology : null;
    const state = this.row(channelId);
    if (!state) throw new HiveError(404, "No adaptive execution in this brain DM");
    if (scope !== "none" && !topology) throw new HiveError(400, "Choose a topology to lock");
    const from = state.currentTopology;
    if (scope === "none") {
      state.lockScope = "none";
      state.lockedTopology = null;
      this.setConversationLock(channelId, null);
    } else {
      state.lockScope = scope;
      state.lockedTopology = topology;
      if (scope === "conversation") this.setConversationLock(channelId, topology);
      const capacity = this.capacity(state);
      const workers = this.budget(topology!, state.recommendation?.targetWorkers ?? minimumWorkers(topology!), capacity.workers);
      if (this.safeFor(state, topology!, workers, capacity)) {
        state.currentTopology = topology!;
        state.workerBudget = workers;
        state.desiredTopology = null;
        state.desiredWorkers = null;
        state.eventsSinceChange = 0;
      } else {
        state.desiredTopology = topology!;
        state.desiredWorkers = Math.max(minimumWorkers(topology!), workers);
      }
    }
    state.updatedAt = Date.now();
    this.save(state);
    const decision: AdaptiveTopologyDecision = state.recommendation ?? {
      routeId: state.executionId, contractVersion: ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
      targetTopology: state.currentTopology, targetWorkers: state.workerBudget, confidence: null,
      reason: "human_lock", providerStatus: "bypassed", model: null, latencyMs: 0,
      inputTokens: null, outputTokens: null, singleSufficient: null, needsOrchestration: null,
    };
    const event = this.eventObject(state, "lock", decision, state.currentTopology !== from, state.warning, from);
    this.persistEvent(event); this.publish(event, state);
    return this.view(actor, channelId);
  }
}
