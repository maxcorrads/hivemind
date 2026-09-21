import { z } from "zod";
import { roomTaskSchema, type RoomTask } from './rooms.ts';
import { claimActions, isClaimAction, type TaskClaim, type TaskCoordinationView } from './task-claims.ts';

const text = z.string().trim().min(1).max(700)
  .describe('Required concise text, 1-700 characters.');
const line = z.string().trim().min(1).max(240)
  .describe('One concise item, 1-240 characters. Split longer material across items instead of exceeding this limit.');
const lines = z.array(line).max(8)
  .describe('At most 8 concise items; use [] when there are none.');
const ids = z.array(z.string().uuid()).max(12).refine(v => new Set(v).size === v.length, "Duplicate IDs")
  .describe('Existing task UUIDs only; use [] when there are none.');
const seqs = z.array(z.number().int().positive().safe()).max(12).refine(v => new Set(v).size === v.length, "Duplicate sequences")
  .describe('Visible message sequence numbers only; use [] when none are needed.');
const hasControl = (value: string) => [...value].some(char => {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
});
const relative = z.string().min(1).max(200).refine(v => !/^(?:[\\/~]|[A-Za-z]:)/.test(v) &&
  !v.includes('\\') && !hasControl(v) && !v.split('/').includes('..'), "Use a relative reference without parent traversal");
const artifact = z.string().min(1).max(500).refine(v => {
  if (!v.includes('://')) return relative.safeParse(v).success;
  try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}, "Use a relative artifact reference or HTTP(S) URL without credentials");

export const taskContractSchema = z.object({
  objective: text.describe('Compact objective, max 700 characters. Put long exact inputs/material here only if they fit; otherwise split concise details across scope items.'),
  scope: lines.describe('0-8 scope items, each max 240 characters. Keep exact long material split across multiple items.'),
  nonGoals: lines.describe('0-8 non-goals, each max 240 characters.'),
  acceptanceCriteria: lines.min(1).describe('1-8 acceptance criteria, each max 240 characters.'),
  dependencies: ids.describe('Existing task UUIDs only, not descriptions or message sequence numbers. Use [] when there are no task dependencies; put prose in scope.'),
  worktree: relative.optional().describe('Optional relative worktree reference. Omit this field entirely when unused; never send an empty string.'),
  branch: z.string().trim().min(1).max(200).refine(v => !/\s/.test(v) && !hasControl(v), 'Use a branch reference without whitespace or control characters').optional()
    .describe('Optional branch reference without whitespace. Omit this field entirely when unused; never send an empty string.'),
  evidenceSeqs: seqs.describe('Evidence messages that both assigner and assignee can already read. Use [] if visibility is uncertain; references never grant access.'),
}).strict();
export const taskResultSchema = z.object({
  summary: text.describe('Result summary, 1-700 characters.'),
  artifacts: z.array(artifact).max(8).describe('0-8 relative artifact references or HTTP(S) URLs.'),
  checks: z.array(z.object({ name: z.string().trim().min(1).max(240),
    outcome: z.enum(['passed', 'failed', 'not_run']), evidenceSeqs: seqs }).strict()).max(8)
    .describe('0-8 reported checks. These are claims, not independently verified by Hivemind.'),
  gaps: lines.describe('0-8 known gaps. Use [] when none are known.'),
  evidenceSeqs: seqs.describe('Visible evidence messages supporting the result. Use [] when none are needed.'),
}).strict();
/** A checkpoint is a report about work, not a new contract or a completion. */
export const taskCheckpointInputSchema = z.object({
  completedSteps: lines,
  unresolvedQuestions: lines,
  nextAction: z.string().trim().min(1).max(400),
  artifacts: taskResultSchema.shape.artifacts,
  checks: taskResultSchema.shape.checks,
  evidenceSeqs: seqs,
}).strict();
export type TaskCheckpointInput = z.infer<typeof taskCheckpointInputSchema>;
export type TaskCheckpoint = {
  version: number; taskRevision: number; contractVersion: number;
  workerId: string; objective: string; worktree?: string; branch?: string;
  savedAt: number; state: TaskState; messageId: string; messageSeq: number;
  data: TaskCheckpointInput;
};
export const taskActionSchema = z.discriminatedUnion('type', [
  ...claimActions,
  z.object({ type: z.literal('checkpoint'), checkpoint: taskCheckpointInputSchema }).strict(),
  z.object({ type: z.literal('accept') }).strict(),
  z.object({ type: z.literal('reject'), reason: text }).strict(),
  z.object({ type: z.literal('block'), needed: text }).strict(),
  z.object({ type: z.literal('result'), result: taskResultSchema }).strict(),
  z.object({ type: z.literal('review'), decision: z.enum(['accepted', 'changes_requested']),
    summary: text, evidenceSeqs: seqs }).strict(),
  z.object({ type: z.literal('revise'), reason: text, worker: z.string().min(1).max(100), contract: taskContractSchema }).strict(),
]).describe('Action MUST be a JSON object with a literal type field. Examples: {type:"accept"}; {type:"result",result:{summary,artifacts,checks,gaps,evidenceSeqs}}; {type:"review",decision:"accepted",summary:"...",evidenceSeqs:[]}. Never omit type and never put serialized JSON inside action.type.');
const requestId = z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);
export const assignTaskSchema = z.object({
  requestId: requestId.describe('Stable idempotency key. Reuse the exact same key and payload on retry.'),
  worker: z.string().min(1).max(100).describe('Exact Hivemind worker name in this project.'),
  channel: z.string().min(1).max(200).optional().describe('Optional existing channel name/UUID. Omit for the default task DM.'),
  contract: taskContractSchema.describe('Required structured contract object; never pass contract as a string.'),
  room: roomTaskSchema.optional().describe('Only for a channel that already has a room contract; copy current contractVersion from get_room and choose a stable actionKey. Omit outside a room.'),
}).strict();
export const taskEventSchema = z.object({
  requestId: requestId.describe('Stable idempotency key. Reuse the exact same key and payload on retry.'),
  expectedRevision: z.number().int().positive().safe().describe('Copy the current task.revision from get_task or the latest task event.'),
  action: taskActionSchema,
}).strict();
export type TaskContract = z.infer<typeof taskContractSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskAction = z.infer<typeof taskActionSchema>;
export type TaskState = 'sent' | 'delivered' | 'accepted' | 'rejected' | 'blocked' | 'result_submitted' | 'changes_requested' | 'accepted_complete';
export type TaskEnvelope = {
  taskId: string; channelId: string; revision: number; contractVersion: number;
  actorId: string; actorRole: 'brain' | 'worker'; assignerId: string; workerId: string;
  previousWorkerId?: string;
  checkpointVersion?: number;
  claimVersion?: number;
  action: TaskAction | { type: 'assign'; contract: TaskContract };
};
export type TaskSnapshot = {
  room?: RoomTask;
  checkpoint?: TaskCheckpoint;
  claim?: TaskClaim;
  coordination?: TaskCoordinationView;
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
  if (isClaimAction(a.type)) {
    return [header, `Advisory claim version ${envelope.claimVersion}`,
      'reason' in a ? `Reason: ${a.reason}` : '',
      'paths' in a ? `Declared intent: ${a.paths.join('; ') || 'no paths declared'}` : '',
      'leaseSeconds' in a ? `Lease requested: ${a.leaseSeconds} seconds` : '',
      'Advisory coordination only: no filesystem lock, code execution, reassignment or change of task authority. Expiry requires explicit reconciliation.'].filter(Boolean).join('\n');
  }
  if (a.type === 'checkpoint') {
    const c = a.checkpoint;
    return [header, `Checkpoint version ${envelope.checkpointVersion}; later checkpoints supersede this report.`,
      `Completed: ${c.completedSteps.join('; ') || 'none reported'}`,
      `Open questions: ${c.unresolvedQuestions.join('; ') || 'none reported'}`,
      `Next action: ${c.nextAction}`, `Artifacts: ${c.artifacts.join('; ') || 'none'}`,
      `Reported checks (not independently verified): ${c.checks.map(check => `${check.name}: ${check.outcome} [${check.evidenceSeqs.join(', ')}]`).join('; ') || 'none run/reported'}`,
      `Evidence seqs: ${c.evidenceSeqs.join(', ') || 'none'}`,
      'Checkpoint only: not completion or a host context reset. Later unsaved work may exist.'].join('\n');
  }
  if (a.type === 'accept') return `${header}\nWorker explicitly accepted the current contract.`;
  if (a.type === 'reject') return `${header}\nReason: ${a.reason}`;
  if (a.type === 'block') return `${header}\nDecision/input needed: ${a.needed}`;
  if (a.type === 'review') return `${header}\nReview: ${a.decision}\n${a.summary}\nEvidence seqs: ${a.evidenceSeqs.join(', ') || 'none'}`;
  if (a.type !== 'result') throw new Error('Unknown task action');
  const r = a.result;
  return [header, r.summary, `Artifacts: ${r.artifacts.join('; ') || 'none'}`,
    `Reported checks (not independently verified): ${r.checks.map(c => `${c.name}: ${c.outcome} [seqs ${c.evidenceSeqs.join(', ')}]`).join('; ') || 'none run/reported'}`,
    `Known gaps: ${r.gaps.join('; ') || 'none reported'}`, `Evidence seqs: ${r.evidenceSeqs.join(', ') || 'none'}`,
    'Result submitted; not accepted-complete until the assigning brain reviews it.'].join('\n');
}
