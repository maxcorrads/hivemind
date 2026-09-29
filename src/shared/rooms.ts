import { z } from 'zod';

const short = z.string().trim().min(1).max(700);
const participants = z.array(z.string().min(1).max(100)).max(16);
export const roomRequestId = z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);
/** One free-text brief plus the two things Hivemind enforces: who coordinates and which workers take room tasks. */
export const roomContractSchema = z.object({
  instructions: z.string().trim().min(1).max(4000),
  coordinator: z.string().min(1).max(100),
  participants,
}).strict();
export const roomActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('configure'), contract: roomContractSchema, reason: short.optional() }).strict(),
  z.object({ type: z.literal('staff'), participants, reason: short.optional() }).strict(),
  z.object({ type: z.literal('archive'), reason: short.optional() }).strict(),
  z.object({ type: z.literal('reopen'), reason: short.optional() }).strict(),
  z.object({ type: z.literal('reconcile'), taskId: z.string().uuid(), decision: z.enum(['continue', 'stop']), reason: short }).strict(),
  z.object({ type: z.literal('acknowledge'), contractVersion: z.number().int().positive().safe() }).strict(),
  z.object({ type: z.literal('stopped'), taskId: z.string().uuid(), reason: short }).strict(),
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
  humanInstructionSeq: number | null; lastEventSeq: number;
  authoritySeq: number; changedBy?: { id: string; name: string; role: string; reason: string } };
export type RoomView = { room: Room | null; archived: boolean; tasks: Array<{ id: string; worker: string; state: string; room: RoomTask }>;
  activeTaskCount: number; tasksHasMore: boolean; nextTaskCursor: string | null; links: SourceLink[]; unmanagedBots: string[] };
export const sourceLinkSchema = z.object({ id: roomRequestId, label: z.string().trim().min(1).max(160), suspendSupported: z.boolean() }).strict();
export const sourceReportSchema = z.object({ generation: z.number().int().positive().safe(),
  observed: z.enum(['running', 'paused', 'failed', 'unsupported']), detail: z.string().max(500).default('') }).strict();
