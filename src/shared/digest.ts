import { z } from "zod";

// Independent of history pagination: exact IDs, in sequence order, with a bounded page.
export const digestExpansionSchema = z.object({
  channel: z.string().min(1).max(200),
  messageIds: z.array(z.string().uuid()).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, "Duplicate message IDs"),
  afterSeq: z.number().int().nonnegative().safe().optional(),
}).strict();
