import { z } from 'zod';

const short = z.string().trim().min(1).max(700);
const lines = z.array(z.string().trim().min(1).max(240)).max(8);
const participants = z.array(z.object({ name: z.string().min(1).max(100), boundary: short }).strict()).max(16);
export const roomRequestId = z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);
export const roomContractSchema = z.object({
  mode: z.enum(['finite', 'ongoing']), purpose: short, rules: lines.min(1), limits: lines,
  coordinator: z.string().min(1).max(100),
  participants,
  completion: lines.min(1), originTaskId: z.string().uuid().nullable(),
}).strict().refine(c => c.mode !== 'finite' || c.originTaskId !== null, 'Finite rooms require an originating task');
export const roomActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('configure'), contract: roomContractSchema, reason: short }).strict(),
  z.object({ type: z.literal('staff'), participants, reason: short }).strict(),
  z.object({ type: z.literal('archive'), running: z.enum(['finish', 'stop']).optional(), reason: short }).strict(),
  z.object({ type: z.literal('reopen'), resumeSources: z.boolean(), reason: short }).strict(),
  z.object({ type: z.literal('reconcile'), taskId: z.string().uuid(), decision: z.enum(['continue', 'stop']), reason: short }).strict(),
  z.object({ type: z.literal('acknowledge'), contractVersion: z.number().int().positive().safe() }).strict(),
  z.object({ type: z.literal('stopped'), taskId: z.string().uuid(), reason: short }).strict(),
  z.object({ type: z.literal('summarize'), summary: short, artifacts: lines }).strict(),
]);
export const roomEventSchema = z.object({ requestId: roomRequestId,
  expectedRevision: z.number().int().nonnegative().safe(), humanInstructionSeq: z.number().int().positive().safe().optional(),
  action: roomActionSchema }).strict();
export const roomTaskSchema = z.object({ contractVersion: z.number().int().positive().safe(), actionKey: roomRequestId }).strict();
export type RoomContract = z.infer<typeof roomContractSchema>;
export type RoomTask = { channelId: string; contractVersion: number; currentVersion: number; roomRevision: number; actionKey: string;
  status: 'active' | 'needs_reconciliation' | 'stop_requested' | 'stopped'; acknowledged: boolean };
export type SourceLink = { id: string; botId: string; label: string; suspendSupported: boolean;
  desired: 'running' | 'paused'; generation: number; observed: 'pending' | 'running' | 'paused' | 'failed' | 'unsupported';
  detail: string; updatedAt: number };
export type Room = { channelId: string; revision: number; contractVersion: number; state: 'active' | 'archived';
  coordinatorId: string; participantIds: string[]; contract: RoomContract; updatedAt: number;
  humanInstructionSeq: number | null; lastEventSeq: number; summarySeq: number | null;
  authoritySeq: number; changedBy?: { id: string; name: string; role: string; reason: string };
  archivedRunning: 'finish' | 'stop' | null };
export type RoomView = { room: Room | null; tasks: Array<{ id: string; worker: string; state: string; room: RoomTask }>;
  activeTaskCount: number; tasksHasMore: boolean; nextTaskCursor: string | null; links: SourceLink[]; unmanagedBots: string[] };
export const sourceLinkSchema = z.object({ id: roomRequestId, label: z.string().trim().min(1).max(160), suspendSupported: z.boolean() }).strict();
export const sourceReportSchema = z.object({ generation: z.number().int().positive().safe(),
  observed: z.enum(['running', 'paused', 'failed', 'unsupported']), detail: z.string().max(500).default('') }).strict();
