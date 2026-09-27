import { z } from "zod";

const reason = z.string().trim().min(1).max(700);
export const taskControlSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive().safe(),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("pause"), mode: z.enum(["soft", "hard"]), reason: reason.optional() }).strict(),
    z.object({ type: z.literal("resume"), reason: reason.optional() }).strict(),
    z.object({ type: z.literal("cancel"), reason }).strict(),
  ]),
}).strict();
export type TaskControlInput = z.infer<typeof taskControlSchema>;
