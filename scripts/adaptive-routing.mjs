import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const ROUTING_SCHEMA_VERSION = 1;
export const ROUTING_CONTRACT_VERSION = 'adaptive-routing-v1';
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_TYPESAFE_MODEL = 'jev-latest';

export const ROUTING_SIGNAL_IDS = Object.freeze([
  'single_agent_sufficiency',
  'complexity',
  'parallelizability',
  'coupling',
  'specialization_need',
  'coordination_need',
]);

export const ROUTING_QUESTIONS = Object.freeze({
  single_agent_sufficiency: {
    type: 'choice',
    instructions: 'Can one capable model session complete this request to the stated quality target without delegation or inter-agent coordination?',
    criteria: {
      sufficient: 'One session has enough context and can complete the work end-to-end without meaningful benefit from delegation.',
      insufficient: 'The work materially benefits from delegation, independent concurrent work, specialist separation, or inter-agent coordination.',
    },
  },
  complexity: {
    type: 'score',
    instructions: 'How structurally complex is the work required by this request?',
    criteria: [
      'Bounded local work with a short dependency chain and few interacting decisions.',
      'Several steps or components with some dependencies, but still tractable in one coherent session.',
      'Many interacting steps, uncertain branches, or a broad dependency graph that is difficult to hold and execute coherently in one session.',
    ],
  },
  parallelizability: {
    type: 'score',
    instructions: 'How much useful work can be split into independent workstreams that can progress concurrently?',
    criteria: [
      'Mostly sequential work; splitting it would create little useful concurrency.',
      'Some independent work can proceed concurrently, but a substantial critical path remains shared.',
      'Multiple meaningful workstreams can progress independently with limited synchronization.',
    ],
  },
  coupling: {
    type: 'score',
    instructions: 'How tightly coupled are the workstreams or decisions in this request?',
    criteria: [
      'Mostly independent pieces with little shared state or cross-impact.',
      'Some shared interfaces, ordering constraints, or cross-checks are required.',
      'Work is tightly coupled through shared state, frequent cross-decisions, or blocking dependencies.',
    ],
  },
  specialization_need: {
    type: 'score',
    instructions: 'How much does the request benefit from distinct specialist roles rather than one generalist session?',
    criteria: [
      'One skill set or a generalist can reasonably cover the work.',
      'Mixed expertise is useful but not essential to quality.',
      'Distinct specialist perspectives or capabilities are materially important to quality or completion.',
    ],
  },
  coordination_need: {
    type: 'score',
    instructions: 'How much explicit coordination between separate workers would be useful for completing this request?',
    criteria: [
      'No meaningful inter-worker coordination is needed.',
      'Some handoff, review, or synchronization would help.',
      'Active peer clarification, shared decisions, or coordinated recovery is important.',
    ],
  },
});

const credentialKey = /^(authorization|api[_-]?key|token|access[_-]?token|accesstoken|refresh[_-]?token|refreshtoken|bearer[_-]?token|bearertoken|password|client[_-]?secret|clientsecret|private[_-]?key|privatekey|secret|credential|credentials)$/i;
const finiteProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const finiteNonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function cleanStructured(value) {
  if (Array.isArray(value)) return value.map(cleanStructured);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (credentialKey.test(key)) continue;
    output[key] = cleanStructured(child);
  }
  return output;
}

export function normalizeRoutingInput(raw) {
  assert.ok(raw && typeof raw === 'object', 'routing input must be an object');
  assert.ok(typeof raw.request === 'string' && raw.request.trim().length > 0, 'routing request is required');
  assert.ok(raw.request.length <= 8_000, 'routing request must be <= 8000 characters');
  const explicitStrategy = raw.explicitStrategy ?? null;
  assert.ok(explicitStrategy === null || ['single', 'orchestrated'].includes(explicitStrategy),
    'explicitStrategy must be single, orchestrated or null');
  const delegationAllowed = raw.delegationAllowed ?? true;
  assert.equal(typeof delegationAllowed, 'boolean', 'delegationAllowed must be boolean');
  const metadata = raw.metadata === undefined ? {} : cleanStructured(raw.metadata);
  assert.ok(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'metadata must be an object');
  return {
    request: raw.request.trim(),
    explicitStrategy,
    delegationAllowed,
    metadata,
  };
}

export function routingState(input) {
  const normalized = normalizeRoutingInput(input);
  return {
    request: normalized.request,
    metadata: normalized.metadata,
  };
}

function answerConfidence(answer, id) {
  assert.ok(answer && typeof answer === 'object', `missing answer ${id}`);
  assert.ok(finiteProbability(answer.confidence), `${id}.confidence must be 0..1`);
  assert.ok(answer.probabilities && typeof answer.probabilities === 'object', `${id}.probabilities is required`);
  const probabilities = Object.values(answer.probabilities);
  assert.ok(probabilities.length >= 2 && probabilities.every(finiteProbability), `${id}.probabilities must be 0..1`);
  const sum = probabilities.reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - 1) <= 0.02, `${id}.probabilities must sum to 1`);
  return answer.confidence;
}

export function validateRoutingSignals(answers) {
  assert.ok(answers && typeof answers === 'object', 'provider answers are required');
  const result = {};
  for (const id of ROUTING_SIGNAL_IDS) assert.ok(Object.hasOwn(answers, id), `missing routing signal ${id}`);

  const sufficiency = answers.single_agent_sufficiency;
  assert.equal(sufficiency.type, 'choice', 'single_agent_sufficiency must be choice');
  assert.ok(['sufficient', 'insufficient'].includes(sufficiency.choice), 'invalid single_agent_sufficiency choice');
  answerConfidence(sufficiency, 'single_agent_sufficiency');
  result.single_agent_sufficiency = {
    type: 'choice',
    choice: sufficiency.choice,
    confidence: sufficiency.confidence,
    probabilities: { ...sufficiency.probabilities },
  };

  for (const id of ROUTING_SIGNAL_IDS.filter(id => id !== 'single_agent_sufficiency')) {
    const answer = answers[id];
    assert.equal(answer.type, 'score', `${id} must be score`);
    assert.ok(typeof answer.score === 'number' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= 2,
      `${id}.score must be 0..2`);
    answerConfidence(answer, id);
    result[id] = {
      type: 'score',
      score: answer.score,
      confidence: answer.confidence,
      probabilities: { ...answer.probabilities },
    };
  }
  return result;
}

export function validateRoutingPolicy(raw) {
  assert.ok(raw && typeof raw === 'object', 'routing policy is required');
  assert.equal(raw.schemaVersion, ROUTING_SCHEMA_VERSION, 'unsupported routing policy schemaVersion');
  assert.ok(typeof raw.id === 'string' && raw.id.length > 0, 'policy id is required');
  assert.equal(raw.contractVersion, ROUTING_CONTRACT_VERSION, 'routing policy contractVersion mismatch');
  assert.equal(raw.mode, 'shadow', 'phase 1 policy must remain shadow');
  assert.ok(['single', 'orchestrated'].includes(raw.fallback), 'policy fallback must be single or orchestrated');
  for (const key of [
    'minConfidence',
    'singleSufficiencyConfidence',
    'singleMaxComplexity',
    'singleMaxCoordinationNeed',
    'singleMaxSpecializationNeed',
    'orchestratedMinCoordinationNeed',
    'orchestratedMinParallelPressure',
    'orchestratedMinSpecializationNeed',
  ]) {
    assert.ok(typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0,
      `policy ${key} must be a non-negative number`);
  }
  assert.ok(raw.minConfidence <= 1 && raw.singleSufficiencyConfidence <= 1, 'confidence thresholds must be <= 1');
  for (const key of [
    'singleMaxComplexity',
    'singleMaxCoordinationNeed',
    'singleMaxSpecializationNeed',
    'orchestratedMinCoordinationNeed',
    'orchestratedMinParallelPressure',
    'orchestratedMinSpecializationNeed',
  ]) assert.ok(raw[key] <= 2, `policy ${key} must be <= 2`);
  assert.ok(raw.activationGate && raw.activationGate.enabled === false,
    'phase 1 active routing must remain disabled');
  assert.ok(Array.isArray(raw.activationGate.requiredEvidence) && raw.activationGate.requiredEvidence.length > 0,
    'activationGate.requiredEvidence is required');
  return structuredClone(raw);
}

export function decideRouting(signals, policy) {
  const checkedSignals = validateRoutingSignals(signals);
  const checkedPolicy = validateRoutingPolicy(policy);
  const confidences = ROUTING_SIGNAL_IDS.map(id => checkedSignals[id].confidence);
  const minimumConfidence = Math.min(...confidences);
  if (minimumConfidence < checkedPolicy.minConfidence) {
    return {
      strategy: checkedPolicy.fallback,
      reason: 'low_confidence_fallback',
      fallbackUsed: true,
      minimumConfidence,
    };
  }

  const sufficiency = checkedSignals.single_agent_sufficiency;
  const complexity = checkedSignals.complexity.score;
  const coordination = checkedSignals.coordination_need.score;
  const specialization = checkedSignals.specialization_need.score;
  const parallelPressure = Math.max(0,
    checkedSignals.parallelizability.score - (checkedSignals.coupling.score * 0.5));

  if (sufficiency.choice === 'sufficient' &&
      sufficiency.confidence >= checkedPolicy.singleSufficiencyConfidence &&
      complexity <= checkedPolicy.singleMaxComplexity &&
      coordination <= checkedPolicy.singleMaxCoordinationNeed &&
      specialization <= checkedPolicy.singleMaxSpecializationNeed) {
    return {
      strategy: 'single',
      reason: 'high_confidence_single_sufficient',
      fallbackUsed: false,
      minimumConfidence,
      parallelPressure,
    };
  }

  if (coordination >= checkedPolicy.orchestratedMinCoordinationNeed ||
      parallelPressure >= checkedPolicy.orchestratedMinParallelPressure ||
      specialization >= checkedPolicy.orchestratedMinSpecializationNeed) {
    return {
      strategy: 'orchestrated',
      reason: 'coordination_pressure',
      fallbackUsed: false,
      minimumConfidence,
      parallelPressure,
    };
  }

  return {
    strategy: checkedPolicy.fallback,
    reason: 'ambiguous_policy_fallback',
    fallbackUsed: true,
    minimumConfidence,
    parallelPressure,
  };
}

function providerFailure(policy, reason, detail, startedAt, stateDigest) {
  return {
    schemaVersion: ROUTING_SCHEMA_VERSION,
    contractVersion: ROUTING_CONTRACT_VERSION,
    mode: 'shadow',
    stateDigest,
    provider: {
      name: 'typesafe',
      status: 'unavailable',
      model: null,
      latencyMs: Date.now() - startedAt,
      usage: null,
      cost: null,
      costCurrency: null,
      error: reason,
      detail,
    },
    signals: null,
    prediction: {
      strategy: policy.fallback,
      reason: `provider_${reason}_fallback`,
      fallbackUsed: true,
      eligibleForActiveRouting: false,
    },
  };
}

function validateProviderEnvelope(payload) {
  assert.ok(payload && typeof payload === 'object', 'provider response must be an object');
  assert.ok(typeof payload.model === 'string' && payload.model.length > 0, 'provider model is required');
  const signals = validateRoutingSignals(payload.answers);
  const usage = payload.usage;
  assert.ok(usage && Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0,
    'provider usage.input_tokens is required');
  assert.ok(Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0,
    'provider usage.output_tokens is required');
  return { model: payload.model, signals, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } };
}

export async function evaluateAdaptiveRouting(rawInput, options) {
  const input = normalizeRoutingInput(rawInput);
  const policy = validateRoutingPolicy(options.policy);
  const state = routingState(input);
  const stateDigest = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const startedAt = Date.now();

  if (input.explicitStrategy) {
    return {
      schemaVersion: ROUTING_SCHEMA_VERSION,
      contractVersion: ROUTING_CONTRACT_VERSION,
      mode: 'shadow',
      stateDigest,
      provider: { name: 'deterministic', status: 'bypassed', model: null, latencyMs: 0, usage: null, cost: null, costCurrency: null, error: null, detail: 'explicit_strategy' },
      signals: null,
      prediction: { strategy: input.explicitStrategy, reason: 'explicit_strategy', fallbackUsed: false, eligibleForActiveRouting: false },
    };
  }
  if (!input.delegationAllowed) {
    return {
      schemaVersion: ROUTING_SCHEMA_VERSION,
      contractVersion: ROUTING_CONTRACT_VERSION,
      mode: 'shadow',
      stateDigest,
      provider: { name: 'deterministic', status: 'bypassed', model: null, latencyMs: 0, usage: null, cost: null, costCurrency: null, error: null, detail: 'delegation_not_allowed' },
      signals: null,
      prediction: { strategy: 'single', reason: 'delegation_not_allowed', fallbackUsed: false, eligibleForActiveRouting: false },
    };
  }

  if (options.provider === 'off') return providerFailure(policy, 'disabled', 'external routing disabled', startedAt, stateDigest);
  assert.equal(options.provider, 'typesafe', 'provider must be typesafe or off');
  if (!options.apiKey) return providerFailure(policy, 'missing_credentials', 'TYPESAFE_API_KEY is not configured', startedAt, stateDigest);

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 10_000, 'timeoutMs must be 100..10000');
  const request = {
    state,
    model: options.model ?? DEFAULT_TYPESAFE_MODEL,
    questions: ROUTING_QUESTIONS,
  };

  let response;
  try {
    response = await fetchImpl(options.endpoint ?? TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network_error';
    return providerFailure(policy, name, String(error?.message ?? error), startedAt, stateDigest);
  }

  if (!response?.ok) {
    const status = Number(response?.status) || 0;
    const detail = await response?.text?.().catch(() => '') ?? '';
    return providerFailure(policy, 'http_error', `HTTP ${status}${detail ? `: ${detail.slice(0, 300)}` : ''}`, startedAt, stateDigest);
  }

  let envelope;
  try {
    envelope = validateProviderEnvelope(await response.json());
  } catch (error) {
    return providerFailure(policy, 'malformed_response', String(error?.message ?? error), startedAt, stateDigest);
  }

  const policyDecision = decideRouting(envelope.signals, policy);
  const tokens = envelope.usage.inputTokens + envelope.usage.outputTokens;
  const cost = options.costPerMillionTokens === undefined || options.costPerMillionTokens === null
    ? null
    : (tokens / 1_000_000) * options.costPerMillionTokens;
  if (cost !== null) assert.ok(finiteNonNegative(cost), 'computed provider cost must be non-negative');

  return {
    schemaVersion: ROUTING_SCHEMA_VERSION,
    contractVersion: ROUTING_CONTRACT_VERSION,
    mode: 'shadow',
    stateDigest,
    provider: {
      name: 'typesafe',
      status: 'ok',
      model: envelope.model,
      latencyMs: Date.now() - startedAt,
      usage: envelope.usage,
      cost,
      costCurrency: cost === null ? null : (options.costCurrency ?? 'USD'),
      error: null,
      detail: cost === null ? 'API usage measured; monetary cost unknown unless an explicit local rate is supplied.' : null,
    },
    signals: envelope.signals,
    prediction: {
      ...policyDecision,
      eligibleForActiveRouting: false,
    },
  };
}

export function routingDecisionRecord(input, result, policy, execution = null) {
  const normalized = normalizeRoutingInput(input);
  const checkedPolicy = validateRoutingPolicy(policy);
  return cleanStructured({
    schemaVersion: ROUTING_SCHEMA_VERSION,
    contractVersion: ROUTING_CONTRACT_VERSION,
    recordedAt: new Date().toISOString(),
    input: {
      request: normalized.request,
      metadata: normalized.metadata,
      explicitStrategy: normalized.explicitStrategy,
      delegationAllowed: normalized.delegationAllowed,
    },
    policy: checkedPolicy,
    result,
    execution,
  });
}

export function appendRoutingDecision(file, record) {
  const safe = cleanStructured(record);
  const serialized = JSON.stringify(safe);
  assert.ok(!/"(?:api[_-]?key|authorization|password|secret|credential)"\s*:/i.test(serialized),
    'routing decision record must not contain credential fields');
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, serialized + '\n', 'utf8');
  return safe;
}
