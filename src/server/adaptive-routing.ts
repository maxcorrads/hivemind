import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { HiveError } from "../shared/types.ts";
import type { AdaptiveTopology } from "../shared/adaptive-topology.ts";

export const ADAPTIVE_ROUTING_CONFIG_VERSION = 1;
export const ADAPTIVE_ROUTING_CONTRACT_VERSION = "adaptive-routing-v1";
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-latest";

export type AdaptiveStrategy = "single" | "orchestrated";

type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
};

type ChoiceAnswer = {
  type: "choice";
  choice: "sufficient" | "insufficient";
  confidence: number;
  probabilities: Record<string, number>;
};

export type AdaptiveSignals = {
  single_agent_sufficiency: ChoiceAnswer;
  complexity: ScoreAnswer;
  parallelizability: ScoreAnswer;
  coupling: ScoreAnswer;
  specialization_need: ScoreAnswer;
  coordination_need: ScoreAnswer;
};

export type AdaptiveRoutingDecision = {
  routeId: string;
  strategy: AdaptiveStrategy;
  reason: string;
  fallbackUsed: boolean;
  providerStatus: "ok" | "unavailable" | "bypassed";
  model: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  minimumConfidence: number | null;
  signals: AdaptiveSignals | null;
};

export type AdaptiveRoutingFile = {
  version: 1;
  enabled: boolean;
  apiKey: string;
  fallback: AdaptiveStrategy;
  topologyFallback: Exclude<AdaptiveTopology, "single">;
};

export type AdaptiveRoutingPublic = {
  enabled: boolean;
  apiKeySet: boolean;
  apiKeyHint: string | null;
  model: string;
  fallback: AdaptiveStrategy;
  topologyFallback: Exclude<AdaptiveTopology, "single">;
};

export type AdaptiveRoutingInput = {
  enabled?: boolean;
  apiKey?: string | null;
  fallback?: AdaptiveStrategy;
  topologyFallback?: Exclude<AdaptiveTopology, "single">;
};

const QUESTIONS = Object.freeze({
  single_agent_sufficiency: {
    type: "choice",
    instructions: "Can one capable model session complete this request to the stated quality target without delegation or inter-agent coordination?",
    criteria: {
      sufficient: "One session has enough context and can complete the work end-to-end without meaningful benefit from delegation.",
      insufficient: "The work materially benefits from delegation, independent concurrent work, specialist separation, or inter-agent coordination.",
    },
  },
  complexity: {
    type: "score",
    instructions: "How structurally complex is the work required by this request?",
    criteria: [
      "Bounded local work with a short dependency chain and few interacting decisions.",
      "Several steps or components with some dependencies, but still tractable in one coherent session.",
      "Many interacting steps, uncertain branches, or a broad dependency graph that is difficult to hold and execute coherently in one session.",
    ],
  },
  parallelizability: {
    type: "score",
    instructions: "How much useful work can be split into independent workstreams that can progress concurrently?",
    criteria: [
      "Mostly sequential work; splitting it would create little useful concurrency.",
      "Some independent work can proceed concurrently, but a substantial critical path remains shared.",
      "Multiple meaningful workstreams can progress independently with limited synchronization.",
    ],
  },
  coupling: {
    type: "score",
    instructions: "How tightly coupled are the workstreams or decisions in this request?",
    criteria: [
      "Mostly independent pieces with little shared state or cross-impact.",
      "Some shared interfaces, ordering constraints, or cross-checks are required.",
      "Work is tightly coupled through shared state, frequent cross-decisions, or blocking dependencies.",
    ],
  },
  specialization_need: {
    type: "score",
    instructions: "How much does the request benefit from distinct specialist roles rather than one generalist session?",
    criteria: [
      "One skill set or a generalist can reasonably cover the work.",
      "Mixed expertise is useful but not essential to quality.",
      "Distinct specialist perspectives or capabilities are materially important to quality or completion.",
    ],
  },
  coordination_need: {
    type: "score",
    instructions: "How much explicit coordination between separate workers would be useful for completing this request?",
    criteria: [
      "No meaningful inter-worker coordination is needed.",
      "Some handoff, review, or synchronization would help.",
      "Active peer clarification, shared decisions, or coordinated recovery is important.",
    ],
  },
});

const POLICY = Object.freeze({
  minConfidence: 0.6,
  singleSufficiencyConfidence: 0.8,
  singleMaxComplexity: 0.8,
  singleMaxCoordinationNeed: 0.8,
  singleMaxSpecializationNeed: 0.8,
  orchestratedMinCoordinationNeed: 1.25,
  orchestratedMinParallelPressure: 1.0,
  orchestratedMinSpecializationNeed: 1.25,
  fallback: "orchestrated" as const,
});

function configPath(home: string): string {
  return path.join(home, "adaptive-routing.json");
}

function decisionsPath(home: string): string {
  return path.join(home, "adaptive-routing-decisions.jsonl");
}

function maskKey(value: string): string {
  const key = value.trim();
  if (key.length < 8) return "set";
  return `…${key.slice(-4)}`;
}

function readRawConfig(home: string): AdaptiveRoutingFile | null {
  const file = configPath(home);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AdaptiveRoutingFile>;
    const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
    if (raw.version !== ADAPTIVE_ROUTING_CONFIG_VERSION || typeof raw.enabled !== "boolean") return null;
    if (raw.fallback !== undefined && raw.fallback !== "single" && raw.fallback !== "orchestrated") return null;
    if (raw.topologyFallback !== undefined && !["brain_one_worker", "brain_multi_dm", "brain_multi_room"].includes(raw.topologyFallback)) return null;
    if (raw.enabled && !apiKey) return null;
    return {
      version: 1,
      enabled: raw.enabled,
      apiKey,
      fallback: raw.fallback ?? "orchestrated",
      topologyFallback: raw.topologyFallback ?? "brain_one_worker",
    };
  } catch {
    return null;
  }
}

function persistConfig(home: string, value: AdaptiveRoutingFile): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = path.join(home, `.adaptive-routing-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, configPath(home));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function adaptiveRoutingPublic(home: string): AdaptiveRoutingPublic {
  const config = readRawConfig(home);
  return {
    enabled: config?.enabled ?? false,
    apiKeySet: Boolean(config?.apiKey),
    apiKeyHint: config?.apiKey ? maskKey(config.apiKey) : null,
    model: TYPESAFE_MODEL,
    fallback: config?.fallback ?? "orchestrated",
    topologyFallback: config?.topologyFallback ?? "brain_one_worker",
  };
}

export function saveAdaptiveRouting(home: string, raw: unknown): AdaptiveRoutingPublic {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new HiveError(400, "Adaptive routing settings must be an object");
  const input = raw as AdaptiveRoutingInput & Record<string, unknown>;
  const unknown = Object.keys(input).filter(key =>
    key !== "enabled" && key !== "apiKey" && key !== "fallback" && key !== "topologyFallback");
  if (unknown.length) throw new HiveError(400, "Unknown adaptive routing setting");
  const previous = readRawConfig(home);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new HiveError(400, "Adaptive routing enabled must be boolean");
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== "string")
    throw new HiveError(400, "Invalid TypeSafe API key");
  if (input.fallback !== undefined && input.fallback !== "single" && input.fallback !== "orchestrated")
    throw new HiveError(400, "Adaptive routing fallback must be single or orchestrated");
  if (input.topologyFallback !== undefined &&
      !["brain_one_worker", "brain_multi_dm", "brain_multi_room"].includes(input.topologyFallback))
    throw new HiveError(400, "Adaptive topology fallback must be Brain+1, Multi-DM or Room");
  const enabled = input.enabled ?? previous?.enabled ?? false;
  const apiKey = input.apiKey === null ? "" : input.apiKey?.trim() || previous?.apiKey || "";
  const fallback = input.fallback ?? previous?.fallback ?? "orchestrated";
  const topologyFallback = input.topologyFallback ?? previous?.topologyFallback ?? "brain_one_worker";
  if (apiKey.length > 512) throw new HiveError(400, "TypeSafe API key is too long");
  if (enabled && !apiKey) throw new HiveError(400, "TypeSafe API key is required when Jev adaptive routing is enabled");
  persistConfig(home, { version: 1, enabled, apiKey, fallback, topologyFallback });
  return adaptiveRoutingPublic(home);
}

export function loadAdaptiveRouting(home: string): AdaptiveRoutingFile | null {
  return readRawConfig(home);
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateProbabilityMap(value: unknown, name: string): Record<string, number> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${name}.probabilities is required`);
  const result: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    assert.ok(finiteProbability(probability), `${name}.probabilities must be 0..1`);
    result[key] = probability;
  }
  assert.ok(Object.keys(result).length >= 2, `${name}.probabilities needs at least two entries`);
  const sum = Object.values(result).reduce((total, probability) => total + probability, 0);
  assert.ok(Math.abs(sum - 1) <= 0.02, `${name}.probabilities must sum to 1`);
  return result;
}

function parseSignals(value: unknown): AdaptiveSignals {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Jev answers are required");
  const answers = value as Record<string, unknown>;
  const sufficiency = answers.single_agent_sufficiency as Record<string, unknown> | undefined;
  assert.equal(sufficiency?.type, "choice");
  assert.ok(sufficiency?.choice === "sufficient" || sufficiency?.choice === "insufficient", "Invalid sufficiency choice");
  assert.ok(finiteProbability(sufficiency.confidence), "Invalid sufficiency confidence");
  const parsed: Partial<AdaptiveSignals> = {
    single_agent_sufficiency: {
      type: "choice",
      choice: sufficiency.choice,
      confidence: sufficiency.confidence,
      probabilities: validateProbabilityMap(sufficiency.probabilities, "single_agent_sufficiency"),
    },
  };
  for (const id of ["complexity", "parallelizability", "coupling", "specialization_need", "coordination_need"] as const) {
    const answer = answers[id] as Record<string, unknown> | undefined;
    assert.equal(answer?.type, "score", `${id} must be score`);
    assert.ok(typeof answer.score === "number" && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= 2,
      `${id}.score must be 0..2`);
    assert.ok(finiteProbability(answer.confidence), `${id}.confidence must be 0..1`);
    parsed[id] = {
      type: "score",
      score: answer.score,
      confidence: answer.confidence,
      probabilities: validateProbabilityMap(answer.probabilities, id),
    };
  }
  return parsed as AdaptiveSignals;
}

export function decideAdaptiveStrategy(signals: AdaptiveSignals, fallback: AdaptiveStrategy = POLICY.fallback): {
  strategy: AdaptiveStrategy;
  reason: string;
  fallbackUsed: boolean;
  minimumConfidence: number;
} {
  const confidences = Object.values(signals).map(signal => signal.confidence);
  const minimumConfidence = Math.min(...confidences);
  if (minimumConfidence < POLICY.minConfidence)
    return { strategy: fallback, reason: "low_confidence_fallback", fallbackUsed: true, minimumConfidence };

  const parallelPressure = Math.max(0, signals.parallelizability.score - signals.coupling.score * 0.5);
  if (
    signals.single_agent_sufficiency.choice === "sufficient" &&
    signals.single_agent_sufficiency.confidence >= POLICY.singleSufficiencyConfidence &&
    signals.complexity.score <= POLICY.singleMaxComplexity &&
    signals.coordination_need.score <= POLICY.singleMaxCoordinationNeed &&
    signals.specialization_need.score <= POLICY.singleMaxSpecializationNeed
  ) {
    return {
      strategy: "single",
      reason: "high_confidence_single_sufficient",
      fallbackUsed: false,
      minimumConfidence,
    };
  }
  if (
    signals.coordination_need.score >= POLICY.orchestratedMinCoordinationNeed ||
    parallelPressure >= POLICY.orchestratedMinParallelPressure ||
    signals.specialization_need.score >= POLICY.orchestratedMinSpecializationNeed
  ) {
    return { strategy: "orchestrated", reason: "coordination_pressure", fallbackUsed: false, minimumConfidence };
  }
  return { strategy: fallback, reason: "ambiguous_policy_fallback", fallbackUsed: true, minimumConfidence };
}

export function explicitAdaptiveDecision(strategy: AdaptiveStrategy): AdaptiveRoutingDecision {
  return {
    routeId: `route-${randomUUID()}`,
    strategy,
    reason: `human_explicit_${strategy}`,
    fallbackUsed: false,
    providerStatus: "bypassed",
    model: null,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    minimumConfidence: null,
    signals: null,
  };
}

function failureDecision(routeId: string, reason: string, latencyMs: number, fallback: AdaptiveStrategy): AdaptiveRoutingDecision {
  return {
    routeId,
    strategy: fallback,
    reason: `provider_${reason}_fallback`,
    fallbackUsed: true,
    providerStatus: "unavailable",
    model: null,
    latencyMs,
    inputTokens: null,
    outputTokens: null,
    minimumConfidence: null,
    signals: null,
  };
}

export async function evaluateAdaptiveRequest(
  request: string,
  config: Pick<AdaptiveRoutingFile, "apiKey"> & Partial<Pick<AdaptiveRoutingFile, "fallback">>,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    project?: { slug: string; name: string };
  } = {},
): Promise<AdaptiveRoutingDecision> {
  const text = request.trim();
  const fallback = config.fallback ?? POLICY.fallback;
  if (!text) return failureDecision(`route-${randomUUID()}`, "empty_request", 0, fallback);
  if (text.length > 8_000) throw new HiveError(400, "Adaptive routing request must be <= 8000 characters");
  const routeId = `route-${randomUUID()}`;
  const started = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  try {
    const response = await fetchImpl(TYPESAFE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: {
          request: text,
          project: options.project ? { slug: options.project.slug, name: options.project.name } : undefined,
        },
        model: TYPESAFE_MODEL,
        questions: QUESTIONS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return failureDecision(routeId, `http_${response.status}`, Date.now() - started, fallback);
    const payload = await response.json() as {
      model?: unknown;
      answers?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    const signals = parseSignals(payload.answers);
    assert.ok(typeof payload.model === "string" && payload.model.length > 0, "Jev model is required");
    assert.ok(Number.isSafeInteger(payload.usage?.input_tokens) && Number(payload.usage!.input_tokens) >= 0, "Invalid Jev input token usage");
    assert.ok(Number.isSafeInteger(payload.usage?.output_tokens) && Number(payload.usage!.output_tokens) >= 0, "Invalid Jev output token usage");
    const policy = decideAdaptiveStrategy(signals, fallback);
    return {
      routeId,
      ...policy,
      providerStatus: "ok",
      model: payload.model,
      latencyMs: Date.now() - started,
      inputTokens: Number(payload.usage!.input_tokens),
      outputTokens: Number(payload.usage!.output_tokens),
      signals,
    };
  } catch (error) {
    const name = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      ? "timeout"
      : "network_or_malformed";
    return failureDecision(routeId, name, Date.now() - started, fallback);
  }
}

export function adaptiveDirective(decision: AdaptiveRoutingDecision): string {
  if (decision.strategy === "single") {
    return [
      `[Hivemind adaptive routing · SINGLE · ${decision.routeId}]`,
      "Execute this Human request directly in this brain session. Do not delegate it to workers.",
      "If new evidence reveals that one session cannot safely complete the work, you may escalate to orchestration; state the concrete reason before delegating.",
    ].join("\n");
  }
  return [
    `[Hivemind adaptive routing · ORCHESTRATED · ${decision.routeId}]`,
    "Coordinate this Human request and delegate to workers when useful. Preserve normal Hivemind task/room authority.",
    decision.fallbackUsed ? `The router used its conservative fallback (${decision.reason}).` : "",
  ].filter(Boolean).join("\n");
}

function telemetryRecord(decision: AdaptiveRoutingDecision, body: string, project: { id: string; slug: string }) {
  return {
    schemaVersion: 1,
    contractVersion: ADAPTIVE_ROUTING_CONTRACT_VERSION,
    recordedAt: new Date().toISOString(),
    routeId: decision.routeId,
    project: { id: project.id, slug: project.slug },
    requestHash: createHash("sha256").update(body).digest("hex"),
    requestBytes: Buffer.byteLength(body),
    strategy: decision.strategy,
    reason: decision.reason,
    fallbackUsed: decision.fallbackUsed,
    provider: {
      status: decision.providerStatus,
      model: decision.model,
      latencyMs: decision.latencyMs,
      inputTokens: decision.inputTokens,
      outputTokens: decision.outputTokens,
    },
    minimumConfidence: decision.minimumConfidence,
    signals: decision.signals,
  };
}

export function appendAdaptiveTelemetry(
  home: string,
  decision: AdaptiveRoutingDecision,
  body: string,
  project: { id: string; slug: string },
): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = decisionsPath(home);
  const fd = openSync(file, "a", 0o600);
  chmodSync(file, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(telemetryRecord(decision, body, project)) + "\n");
  } finally {
    closeSync(fd);
  }
}
