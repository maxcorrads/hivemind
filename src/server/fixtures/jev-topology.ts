import assert from 'node:assert/strict';
import type { AdaptiveTopology } from '../../shared/adaptive-topology.ts';

/** Fake provider response derived from the actual offered choices, never a live API call. */
export function jevTopologyResponse(
  requestBody: unknown,
  target: AdaptiveTopology | 'capacity_blocked' = 'single',
  workers = target === 'single' || target === 'capacity_blocked' ? 0 : target === 'brain_one_worker' ? 1 : 2,
  confidence = 0.95,
) {
  const request = typeof requestBody === 'string' ? JSON.parse(requestBody) as Record<string, unknown>
    : requestBody as Record<string, unknown>;
  const questions = request.questions as Record<string, { type: string; criteria: Record<string, string> | string[] }>;
  assert.ok(questions && Object.keys(questions).length >= 7);
  const choose = (selected: string, options: string[]) => {
    assert.ok(options.includes(selected), `Fixture target ${selected} must be an offered option`);
    return { type: 'choice', choice: selected, confidence,
      probabilities: Object.fromEntries(options.map(option => [option, option === selected ? 0.95 : 0.05 / (options.length - 1)])) };
  };
  const single = target === 'single';
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      const selected = id === 'single_agent_sufficiency' ? single ? 'sufficient' : 'insufficient'
        : id === 'target_topology' ? target : `workers_${workers}`;
      answers[id] = choose(selected, Object.keys(question.criteria));
    } else {
      const probabilities = single ? { '0': 0.9, '1': 0.08, '2': 0.02 } : { '0': 0.02, '1': 0.08, '2': 0.9 };
      answers[id] = { type: 'score', score: single ? 0.12 : 1.88, confidence, probabilities };
    }
  }
  return { model: 'jev-topology-fixture', answers, usage: { input_tokens: 80, output_tokens: 20 } };
}
