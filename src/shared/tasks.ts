import { z } from "zod";
import { roomTaskSchema, type RoomTask } from './rooms.ts';

const text = z.string().trim().min(1).max(700);
const lines = z.array(z.string().trim().min(1).max(240)).max(8);
const ids = z.array(z.string().uuid()).max(12).refine(v => new Set(v).size === v.length, "Duplicate IDs");
const seqs = z.array(z.number().int().positive().safe()).max(12).refine(v => new Set(v).size === v.length, "Duplicate sequences");
const relative = z.string().min(1).max(200).refine(v => !/^(?:[\\/~]|[A-Za-z]:)/.test(v) &&
  !/[\\\x00-\x1f\x7f]/.test(v) && !v.split('/').includes('..'), "Use a relative reference without parent traversal");
const artifact = z.string().min(1).max(500).refine(v => {
  if (!v.includes('://')) return relative.safeParse(v).success;
  try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}, "Use a relative artifact reference or HTTP(S) URL without credentials");

export const taskContractSchema = z.object({
  objective: text,
  scope: lines,
  nonGoals: lines,
  acceptanceCriteria: lines.min(1),
  dependencies: ids.describe('Existing task UUIDs only, not descriptions or message sequence numbers. Use [] when there are no task dependencies; put prose in scope.'),
  worktree: relative.optional(),
  branch: z.string().trim().min(1).max(200).regex(/^[^\s\x00-\x1f\x7f]+$/).optional(),
  evidenceSeqs: seqs,
}).strict();
export const taskResultSchema = z.object({
  summary: text,
  artifacts: z.array(artifact).max(8),
  checks: z.array(z.object({ name: z.string().trim().min(1).max(240),
    outcome: z.enum(['passed', 'failed', 'not_run']), evidenceSeqs: seqs }).strict()).max(8),
  gaps: lines,
  evidenceSeqs: seqs,
}).strict();
export const taskActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accept') }).strict(),
  z.object({ type: z.literal('reject'), reason: text }).strict(),
  z.object({ type: z.literal('block'), needed: text }).strict(),
  z.object({ type: z.literal('result'), result: taskResultSchema }).strict(),
  z.object({ type: z.literal('review'), decision: z.enum(['accepted', 'changes_requested']),
    summary: text, evidenceSeqs: seqs }).strict(),
  z.object({ type: z.literal('revise'), reason: text, worker: z.string().min(1).max(100), contract: taskContractSchema }).strict(),
]);
const requestId = z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);
export const assignTaskSchema = z.object({ requestId, worker: z.string().min(1).max(100),
  channel: z.string().min(1).max(200).optional(), contract: taskContractSchema, room: roomTaskSchema.optional() }).strict();
export const taskEventSchema = z.object({ requestId, expectedRevision: z.number().int().positive().safe(), action: taskActionSchema }).strict();
export type TaskContract = z.infer<typeof taskContractSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskAction = z.infer<typeof taskActionSchema>;
export type TaskState = 'sent' | 'delivered' | 'accepted' | 'rejected' | 'blocked' | 'result_submitted' | 'changes_requested' | 'accepted_complete';
export type TaskEnvelope = {
  taskId: string; channelId: string; revision: number; contractVersion: number;
  actorId: string; actorRole: 'brain' | 'worker'; assignerId: string; workerId: string;
  previousWorkerId?: string;
  action: TaskAction | { type: 'assign'; contract: TaskContract };
};
export type TaskSnapshot = {
  room?: RoomTask;
  id: string; channelId: string; assignerId: string; assignerName: string; workerId: string; workerName: string;
  revision: number; contractVersion: number; state: TaskState; contract: TaskContract;
  dispatchSeq: number; receivedAt: number | null; lastEventSeq: number; updatedAt: number;
  result: TaskResult | null; review: { reviewerId: string; decision: 'accepted' | 'changes_requested'; summary: string } | null;
};

/** Human-readable chat stays the primary record; metadata is authenticated by the server. */
export function taskBody(envelope: TaskEnvelope): string {
  const a = envelope.action;
  const header = `Task ${a.type} · ${envelope.taskId} · revision ${envelope.revision} / contract ${envelope.contractVersion}`;
  if (a.type === 'assign' || a.type === 'revise') {
    const c = a.contract;
    return [header, a.type === 'revise' ? `Reason: ${a.reason}` : '', `Objective: ${c.objective}`,
      `Scope: ${c.scope.join('; ') || 'none specified'}`, `Non-goals: ${c.nonGoals.join('; ') || 'none specified'}`,
      `Acceptance: ${c.acceptanceCriteria.join('; ')}`, `Dependencies: ${c.dependencies.join(', ') || 'none'}`,
      `Worktree: ${c.worktree ?? 'not specified'}; branch: ${c.branch ?? 'not specified'}`,
      `Evidence seqs: ${c.evidenceSeqs.join(', ') || 'none'}`].filter(Boolean).join('\n');
  }
  if (a.type === 'accept') return `${header}\nWorker explicitly accepted the current contract.`;
  if (a.type === 'reject') return `${header}\nReason: ${a.reason}`;
  if (a.type === 'block') return `${header}\nDecision/input needed: ${a.needed}`;
  if (a.type === 'review') return `${header}\nReview: ${a.decision}\n${a.summary}\nEvidence seqs: ${a.evidenceSeqs.join(', ') || 'none'}`;
  const r = a.result;
  return [header, r.summary, `Artifacts: ${r.artifacts.join('; ') || 'none'}`,
    `Reported checks (not independently verified): ${r.checks.map(c => `${c.name}: ${c.outcome} [seqs ${c.evidenceSeqs.join(', ')}]`).join('; ') || 'none run/reported'}`,
    `Known gaps: ${r.gaps.join('; ') || 'none reported'}`, `Evidence seqs: ${r.evidenceSeqs.join(', ') || 'none'}`,
    'Result submitted; not accepted-complete until the assigning brain reviews it.'].join('\n');
}
