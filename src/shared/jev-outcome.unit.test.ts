import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JEV_ADVICE_NOTE, type AdaptiveTopologyDecision } from './adaptive-topology.ts';
import { jevAdvice, jevAdviceLabel, jevAnswerState, jevModelDisplay } from './jev-outcome.ts';

const base: AdaptiveTopologyDecision = { routeId: 'r', contractVersion: 'adaptive-routing-v3', targetTopology: 'brain_multi_dm',
  targetWorkers: 2, confidence: 0.72, reason: 'parallel_workstreams', providerStatus: 'ok', model: 'jev-1.13.0', latencyMs: 5,
  inputTokens: 10, outputTokens: 2, singleSufficient: false, needsOrchestration: true };
const failed = { ...base, providerStatus: 'unavailable' as const, targetTopology: 'single' as const, targetWorkers: 0,
  confidence: null, model: null, inputTokens: null, outputTokens: null };

test('each Jev outcome has one state and one precise advisory label; an answer that arrived is never "unavailable"', () => {
  const cases: Array<[AdaptiveTopologyDecision, string, string]> = [
    [base, 'answered', 'Jev suggested Multi-DM · 2 workers (72%)'],
    [{ ...base, targetTopology: 'single', targetWorkers: 0, confidence: 0.6, reason: 'single_sufficient' }, 'answered', 'Jev suggested Single (60%)'],
    [{ ...base, confidence: 0.17 }, 'uncertain', 'Jev uncertain (17%) · Multi-DM · 2 workers'],
    [{ ...base, confidence: null }, 'uncertain', 'Jev uncertain (no confidence) · Multi-DM · 2 workers'],
    [{ ...base, incoherent: 'plan_vs_sufficiency' }, 'incoherent', 'Jev uncertain (incoherent: plan contradicts sufficiency)'],
    [{ ...failed, reason: 'provider_timeout', error: 'timeout' }, 'unavailable', 'Jev unavailable (timeout)'],
    [{ ...failed, reason: 'provider_unavailable', error: 'http_503' }, 'unavailable', 'Jev unavailable (http_503)'],
    [{ ...failed, reason: 'provider_unavailable' }, 'unavailable', 'Jev unavailable'],
    [{ ...failed, reason: 'response_rejected', model: 'jev-1.13.0', inputTokens: 5, error: 'plan_not_offered' },
      'rejected', 'Jev answer rejected (plan_not_offered)'],
    // Rows recorded before #214 keep their old reason names.
    [{ ...failed, reason: 'provider_timeout_preserve_current', error: 'timeout' }, 'unavailable', 'Jev unavailable (timeout)'],
    [{ ...failed, reason: 'response_rejected_preserve_current', error: 'plan_not_offered' }, 'rejected', 'Jev answer rejected (plan_not_offered)'],
    [{ ...failed, reason: 'capacity_changed_during_initial_routing', model: 'jev-1.13.0', inputTokens: 5 }, 'stale', 'Capacity changed during the Jev call'],
    [{ ...failed, providerStatus: 'bypassed', reason: 'jev_disabled_manual_override' }, 'bypassed', 'Jev not called'],
    [{ ...base, targetTopology: 'single', targetWorkers: 0, reason: 'orchestration_needed_no_capacity' }, 'answered',
      'Jev suggested Needs workers, none available (72%)'],
  ];
  for (const [decision, state, label] of cases) {
    assert.equal(jevAnswerState(decision), state, JSON.stringify(decision));
    assert.equal(jevAdviceLabel(decision), label, JSON.stringify(decision));
  }
});

test('the advice a brain receives names the plan, its state and the advisory note (#211)', () => {
  assert.deepEqual(jevAdvice(base, 42), { plan: 'brain_multi_dm_2', topology: 'brain_multi_dm', workers: 2, confidence: 0.72,
    state: 'ok', reason: 'parallel_workstreams', at: 42, note: JEV_ADVICE_NOTE });
  assert.equal(JEV_ADVICE_NOTE, 'Advisory only — you decide; Human instructions take precedence.');
  assert.equal(jevAdvice({ ...base, confidence: 0.3 }, 1)!.state, 'uncertain');
  assert.equal(jevAdvice({ ...base, incoherent: 'plan_vs_sufficiency' }, 1)!.state, 'incoherent');
  assert.equal(jevAdvice({ ...base, targetTopology: 'single', targetWorkers: 0, reason: 'orchestration_needed_no_capacity' }, 1)!.plan, 'capacity_blocked');
  assert.deepEqual(jevAdvice({ ...failed, reason: 'provider_timeout', error: 'timeout' }, 7),
    { plan: null, topology: null, workers: null, confidence: null, state: 'unavailable', reason: 'timeout', at: 7, note: JEV_ADVICE_NOTE });
  assert.equal(jevAdvice({ ...failed, reason: 'response_rejected', model: 'm', error: 'plan_not_offered' }, 1)!.state, 'rejected');
  assert.equal(jevAdvice({ ...failed, reason: 'capacity_changed_during_initial_routing' }, 1)!.state, 'unavailable');
  assert.equal(jevAdvice({ ...failed, providerStatus: 'bypassed' }, 1), null);
});

test('an alias resolving to a concrete version is information; only a pinned mismatch is flagged', () => {
  assert.deepEqual(jevModelDisplay('jev-latest', 'jev-1.13.0'), { text: 'jev-latest → jev-1.13.0', mismatch: false });
  assert.deepEqual(jevModelDisplay('jev-2026-09-01', 'jev-2026-09-01'), { text: 'jev-2026-09-01', mismatch: false });
  assert.deepEqual(jevModelDisplay('jev-2026-09-01', 'jev-1.13.0'), { text: 'jev-2026-09-01 → jev-1.13.0', mismatch: true });
  assert.deepEqual(jevModelDisplay(null, 'jev-1.13.0'), { text: 'jev-1.13.0', mismatch: false });
  assert.deepEqual(jevModelDisplay('jev-latest', null), { text: 'jev-latest', mismatch: false });
  assert.deepEqual(jevModelDisplay(undefined, null), { text: '—', mismatch: false });
});
