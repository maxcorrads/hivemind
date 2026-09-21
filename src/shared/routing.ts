import { z } from 'zod';

export const ROUTING_LIMITS = Object.freeze({ cards: 256, samples: 2048, evidence: 64, page: 12, retentionMs: 90 * 86400_000 });
const tag = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9.+_-]*$/);
const tags = z.array(tag).max(12).refine(v => new Set(v).size === v.length, 'Duplicate capability');
export const capabilityCardSchema = z.object({
  enabled: z.boolean(), capabilities: tags.min(1),
  modes: z.array(z.enum(['implementation', 'review', 'read_only'])).min(1).max(3)
    .refine(v => new Set(v).size === v.length, 'Duplicate mode'),
  model: z.string().trim().min(1).max(80).nullable(), host: z.string().trim().min(1).max(80).nullable(),
  availableContext: z.number().int().min(1).max(10_000_000).nullable(),
  availability: z.enum(['available', 'busy', 'unavailable']), maxInProgress: z.number().int().min(1).max(8),
}).strict();
export const setCapabilitiesSchema = z.object({ expectedRevision: z.number().int().nonnegative().safe(), card: capabilityCardSchema }).strict();
export const suggestWorkersSchema = z.object({
  requiredCapabilities: tags.default([]).describe('Optional capability filter. Omit or pass [] when no specific capability is required.'),
  mode: z.enum(['implementation', 'review', 'read_only']), category: tag,
  minContext: z.number().int().min(1).max(10_000_000).optional(),
  minReviewedResults: z.number().int().min(0).max(64).optional(),
  minimumAcceptedRate: z.number().min(0).max(1).optional(),
  offset: z.number().int().min(0).max(255).optional(),
}).strict();
export const routingOutcomeSchema = z.object({ expectedRevision: z.number().int().positive().safe(), category: tag,
  capabilityRevision: z.number().int().positive().safe() }).strict();
export const routingOverrideSchema = z.object({ expectedRevision: z.number().int().positive().safe(),
  requestId: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/), workerId: z.string().uuid(),
  reason: z.string().trim().min(1).max(700) }).strict();
export type CapabilityCard = z.infer<typeof capabilityCardSchema>;
export type CapabilityView = { workerId: string; revision: number; updatedAt: number; card: CapabilityCard };
export type RoutingRequest = z.infer<typeof suggestWorkersSchema>;
export type WorkerSuggestion = {
  workerId: string; name: string; capabilityRevision: number; card: CapabilityCard;
  visibleInProgress: number; workloadIncomplete: boolean;
  evidence: { reviewed: number; accepted: number; acceptedRate: number | null; interval95: [number, number] | null; basis: string };
  reasons: string[]; providerCost: null;
};
export type RoutingSuggestions = {
  taskId: string; taskRevision: number; category: string; candidates: WorkerSuggestion[];
  eligibleTotal: number; consideredCards: number; nextOffset: number | null;
  warning: string; delegationAdvice: string;
};
/** Descriptive Wilson interval, not a guarantee of a worker's general ability. */
export function outcomeInterval(accepted: number, reviewed: number): [number, number] | null {
  if (!reviewed) return null;
  const z = 1.96, p = accepted / reviewed, denominator = 1 + z * z / reviewed;
  const center = (p + z * z / (2 * reviewed)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / reviewed + z * z / (4 * reviewed * reviewed)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
