import { z } from 'zod';

const title = z.string().trim().min(1).max(240);
export const jobReferenceSchema = z.union([
  z.object({ id: z.string().uuid() }).strict(),
  z.object({ title, originMessageId: z.string().uuid().optional() }).strict(),
]);
export const jobEventSchema = z.object({
  requestId: z.string().uuid(), type: z.literal('open'), title,
  originMessageId: z.string().uuid().optional(),
}).strict();
export const closeJobSchema = z.object({ expectedRevision: z.number().int().positive().safe() }).strict();
export type JobView = {
  id: string; projectId: string; brainId: string; originMessageId: string | null;
  title: string; state: 'active' | 'paused' | 'done' | 'cancelled'; revision: number;
  createdAt: number; updatedAt: number; closedAt: number | null;
  counts: { total: number; completed: number; cancelled: number; paused: number; active: number };
};
