import { z } from 'zod';
import type { TaskSnapshot } from './tasks.ts';

export const CLAIM_LIMITS = Object.freeze({ project: 256, coordinator: 8, worker: 4, graph: 256 });
const intent = z.string().min(1).max(200).refine(value =>
  !/^(?:[\\/~]|[A-Za-z]:)/.test(value) && ![...value].some(char => '\\*?[]{}'.includes(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
'Use a relative file/module reference without traversal, wildcards or empty segments');
const paths = z.array(intent).max(8).refine(values => new Set(values).size === values.length, 'Duplicate intent');
const acknowledgements = z.array(z.object({ taskId: z.string().uuid(),
  claimVersion: z.number().int().positive().safe() }).strict()).max(12)
  .refine(values => new Set(values.map(value => value.taskId)).size === values.length, 'Duplicate overlap acknowledgement');
const leaseSeconds = z.number().int().min(30).max(3600);
const reason = z.string().trim().min(1).max(700);
export const claimPreviewSchema = z.object({ paths }).strict();
export const claimActions = [
  z.object({ type: z.literal('claim'), leaseSeconds, paths, overlapAcknowledgements: acknowledgements }).strict(),
  z.object({ type: z.literal('renew_claim'), leaseSeconds, overlapAcknowledgements: acknowledgements }).strict(),
  z.object({ type: z.literal('release_claim'), reason }).strict(),
  z.object({ type: z.literal('reconcile_claim'), reason, leaseSeconds, paths,
    overlapAcknowledgements: acknowledgements }).strict(),
] as const;
export const claimActionSchema = z.discriminatedUnion('type', claimActions);
export type ClaimAction = z.infer<typeof claimActionSchema>;
export type TaskClaim = {
  version: number; coordinatorId: string; coordinatorName: string; workerId: string;
  contractVersion: number; state: 'held' | 'released'; paths: string[];
  overlapAcknowledgements: Array<{ taskId: string; claimVersion: number }>;
  updatedAt: number; expiresAt: number;
};
export type TaskCoordinationView = {
  dependencies: Array<{ taskId: string; status: 'accepted_complete' | 'not_complete' | 'unavailable' }>;
  claim: 'none' | 'held' | 'uncertain' | 'released';
  overlaps: Array<{ taskId: string; claimVersion: number; paths: string[]; acknowledged: boolean; status: 'held' | 'uncertain' }>;
  truncated: boolean;
};
export function isClaimAction(type: string): type is ClaimAction['type'] {
  return ['claim', 'renew_claim', 'release_claim', 'reconcile_claim'].includes(type);
}
export function claimState(task: Pick<TaskSnapshot, 'claim' | 'contractVersion' | 'workerId'>, now = Date.now()): TaskCoordinationView['claim'] {
  const claim = task.claim;
  if (!claim) return 'none';
  if (claim.state === 'released') return 'released';
  return claim.expiresAt <= now || claim.contractVersion !== task.contractVersion || claim.workerId !== task.workerId
    ? 'uncertain' : 'held';
}
export function overlappingPaths(a: string[], b: string[]): string[] {
  return a.filter(left => b.some(right => left === right || left.startsWith(right + '/') || right.startsWith(left + '/')));
}
