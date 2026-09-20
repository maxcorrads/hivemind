import { z } from 'zod';

const text = z.string().trim().min(1).max(700);
const short = z.string().trim().min(1).max(240);
const requestId = z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);
const ids = z.array(z.string().uuid()).max(12).refine(values => new Set(values).size === values.length, 'Duplicate IDs');
const seqs = z.array(z.number().int().positive().safe()).max(12).refine(values => new Set(values).size === values.length, 'Duplicate sequences');
const names = z.array(z.string().trim().min(1).max(100)).min(1).max(8)
  .refine(values => new Set(values).size === values.length, 'Duplicate affected worker');
const artifact = z.string().trim().min(1).max(500).refine(value => {
  if (!value.includes('://')) return !/^(?:[\\/~]|[A-Za-z]:)/.test(value) && !value.includes('\\') &&
    !value.split('/').includes('..') && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, 'Use a relative artifact reference or HTTP(S) URL without credentials');

export const decisionOptionSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  label: short,
  impact: text,
}).strict();

export const decisionRecommendationSchema = z.object({
  optionId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).nullable(),
  rationale: text,
  uncertainty: short,
}).strict();

export const requestDecisionSchema = z.object({
  requestId,
  taskId: z.string().uuid(),
  expectedTaskRevision: z.number().int().positive().safe(),
  question: text,
  options: z.array(decisionOptionSchema).max(6).refine(values => values.length === 0 || values.length >= 2,
    'Provide either no options or at least two distinct options'),
  recommendation: decisionRecommendationSchema.nullable(),
  evidenceSeqs: seqs,
  artifacts: z.array(artifact).max(8),
  affectedWorkers: names,
  requestedByAt: z.number().int().positive().safe().optional(),
  relatedDecisionIds: ids,
  supersedesDecisionId: z.string().uuid().optional(),
}).strict().superRefine((value, ctx) => {
  const optionIds = value.options.map(option => option.id);
  if (new Set(optionIds).size !== optionIds.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Duplicate option id' });
  if (value.recommendation?.optionId && !optionIds.includes(value.recommendation.optionId))
    ctx.addIssue({ code: 'custom', path: ['recommendation', 'optionId'], message: 'Recommended option must exist' });
  if (value.supersedesDecisionId && value.relatedDecisionIds.includes(value.supersedesDecisionId))
    ctx.addIssue({ code: 'custom', path: ['supersedesDecisionId'], message: 'Superseded decision is linked separately' });
});

export const decisionEventSchema = z.object({
  requestId,
  expectedRevision: z.number().int().positive().safe(),
  action: z.object({ type: z.literal('withdraw'), reason: text }).strict(),
}).strict();

export const decisionAnswerSchema = z.object({
  requestId,
  expectedRevision: z.number().int().positive().safe(),
  body: text,
}).strict();

export type DecisionState = 'awaiting_input' | 'answered' | 'withdrawn' | 'expired' | 'superseded';
export type DecisionDeliveryState = 'pending' | 'offered' | 'acknowledged';
export type DecisionSnapshot = {
  id: string;
  projectId: string;
  channelId: string;
  taskId: string;
  taskRevision: number;
  requesterId: string;
  requesterName: string;
  revision: number;
  storedState: 'awaiting_input' | 'answered' | 'withdrawn' | 'superseded';
  question: string;
  options: z.infer<typeof decisionOptionSchema>[];
  recommendation: z.infer<typeof decisionRecommendationSchema> | null;
  evidenceSeqs: number[];
  artifacts: string[];
  affectedWorkers: Array<{ id: string; name: string }>;
  requestedByAt: number | null;
  relatedDecisionIds: string[];
  supersedesDecisionId: string | null;
  supersededByDecisionId: string | null;
  rootSeq: number;
  createdAt: number;
  updatedAt: number;
  answer: null | { messageId: string; seq: number; body: string; at: number; source: 'hive' | 'telegram' };
  withdrawn: null | { reason: string; at: number };
};

export type DecisionView = Omit<DecisionSnapshot, 'storedState'> & {
  state: DecisionState;
  storedState: DecisionSnapshot['storedState'];
  currentTaskRevision: number;
  staleReason: 'task_changed' | 'deadline_passed' | null;
  delivery: Array<{ agentId: string; name: string; state: DecisionDeliveryState }>;
  warning: string;
};

export type DecisionPage = {
  items: DecisionView[];
  awaiting: number;
  warning: string;
};

export function decisionBody(input: z.infer<typeof requestDecisionSchema>, requester: string) {
  const options = input.options.length ? input.options.map(option => `${option.id}) ${option.label} — impact: ${option.impact}`).join('\n') : 'Free-text response requested.';
  const recommendation = input.recommendation
    ? `Recommendation: ${input.recommendation.optionId ?? 'no specific option'} — ${input.recommendation.rationale}\nUncertainty: ${input.recommendation.uncertainty}`
    : 'Recommendation: none supplied.';
  return [
    `Decision needed · task ${input.taskId} · task revision ${input.expectedTaskRevision}`,
    `From: ${requester}`,
    `Question: ${input.question}`,
    'Options:',
    options,
    recommendation,
    `Affected workers: ${input.affectedWorkers.join(', ')}`,
    `Evidence seqs: ${input.evidenceSeqs.join(', ') || 'none'}`,
    `Artifacts: ${input.artifacts.join('; ') || 'none'}`,
    input.requestedByAt ? `Requested by: ${new Date(input.requestedByAt).toISOString()}` : 'Requested by: no deadline',
    'Reply in this thread. Expiry or a recommendation never authorizes an option automatically.',
  ].join('\n');
}
