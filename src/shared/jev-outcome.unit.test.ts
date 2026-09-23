import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jevAnswerState, jevDecisionActionable, jevModelDisplay, jevNotUsedLabel } from './jev-outcome.ts';

const ok = { providerStatus: 'ok' as const, confidence: 0.9, reason: 'single_sufficient', model: 'jev-1.13.0', inputTokens: 10 };
const failed = { providerStatus: 'unavailable' as const, confidence: null, model: null, inputTokens: null };

test('each Jev outcome has one state and one precise label; an answer that arrived is never "unavailable"', () => {
  const cases: Array<[Parameters<typeof jevNotUsedLabel>[0], string, string | null]> = [
    [ok, 'answered', null],
    [{ ...ok, confidence: 0.6 }, 'answered', null],
    [{ ...ok, confidence: 0.17 }, 'uncertain', 'Jev uncertain (17%)'],
    [{ ...ok, confidence: null }, 'uncertain', 'Jev uncertain (no confidence)'],
    [{ ...ok, incoherent: 'plan_vs_sufficiency' }, 'incoherent', 'Jev uncertain (incoherent: plan contradicts sufficiency)'],
    [{ ...failed, reason: 'provider_timeout_preserve_current', error: 'timeout' }, 'unavailable', 'Jev unavailable (timeout)'],
    [{ ...failed, reason: 'provider_unavailable_preserve_current', error: 'http_503' }, 'unavailable', 'Jev unavailable (http_503)'],
    [{ ...failed, reason: 'provider_unavailable_preserve_current' }, 'unavailable', 'Jev unavailable'],
    [{ ...failed, reason: 'response_rejected_preserve_current', model: 'jev-1.13.0', inputTokens: 5, error: 'plan_not_offered' },
      'rejected', 'Jev answer rejected (plan_not_offered)'],
    [{ ...failed, reason: 'response_rejected_preserve_current', error: 'model_missing' }, 'rejected', 'Jev answer rejected (model_missing)'],
    [{ ...failed, reason: 'capacity_changed_during_initial_routing', model: 'jev-1.13.0', inputTokens: 5 }, 'stale', 'Capacity changed during the Jev call'],
    [{ ...failed, providerStatus: 'bypassed', reason: 'jev_disabled_manual_override' }, 'bypassed', null],
  ];
  for (const [decision, state, label] of cases) {
    assert.equal(jevAnswerState(decision), state, JSON.stringify(decision));
    assert.equal(jevNotUsedLabel(decision), label, JSON.stringify(decision));
    assert.equal(jevDecisionActionable(decision), state === 'answered');
  }
});

test('an alias resolving to a concrete version is information; only a pinned mismatch is flagged', () => {
  assert.deepEqual(jevModelDisplay('jev-latest', 'jev-1.13.0'), { text: 'jev-latest → jev-1.13.0', mismatch: false });
  assert.deepEqual(jevModelDisplay('jev-2026-09-01', 'jev-2026-09-01'), { text: 'jev-2026-09-01', mismatch: false });
  assert.deepEqual(jevModelDisplay('jev-2026-09-01', 'jev-1.13.0'), { text: 'jev-2026-09-01 → jev-1.13.0', mismatch: true });
  assert.deepEqual(jevModelDisplay(null, 'jev-1.13.0'), { text: 'jev-1.13.0', mismatch: false });
  assert.deepEqual(jevModelDisplay('jev-latest', null), { text: 'jev-latest', mismatch: false });
  assert.deepEqual(jevModelDisplay(undefined, null), { text: '—', mismatch: false });
});
