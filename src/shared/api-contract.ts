import { z } from "zod";
import { BODY_MAX, DEFAULT_WAIT_MS, FILE_MAX_BYTES, HiveError, MESSAGE_EVENT_TYPES } from "./types.ts";
import { executionIdSchema, requestIdSchema } from "./mutation.ts";

export const API_JSON_BYTES = 128 * 1024;
export const MAX_WAIT_MS = DEFAULT_WAIT_MS; // Preserve the existing 25-minute long poll.
export const REQUEST_BODY_MS = 120_000;
export const REQUEST_HEADER_MS = 15_000;
export const UPLOAD_DEADLINE_MS = 60_000;
export const ORDINARY_REQUEST_MS = 30_000;
export const safeInteger = z.number().int().safe();
export const cursorSchema = safeInteger.nonnegative();
export const sequenceSchema = safeInteger.positive();
// Larger requested pages retain the existing documented server clamp to 200.
export const limitSchema = safeInteger.positive();
export const waitDurationSchema = safeInteger.min(1).max(MAX_WAIT_MS);
export const senioritySchema = z.enum(["junior", "mid", "senior"]);
export const nameSchema = z.string().trim().min(1).max(100);
export const referenceSchema = z.string().min(1).max(256);
export const memberNamesSchema = z.array(nameSchema).max(32);
export const attachmentIdsSchema = z.array(z.string().uuid()).max(4);
export const messageBodySchema = z.string().max(BODY_MAX).refine(value =>
  new TextEncoder().encode(value).length <= BODY_MAX * 4, "Message exceeds UTF-8 budget");
export const joinInputSchema = z.object({
  role: z.enum(["brain", "worker"]), seniority: senioritySchema.nullish(),
  focus: z.string().max(4000).nullish(), token: z.string().min(1).max(512).nullish(),
  resumeName: nameSchema.nullish(), project: z.string().min(1).max(32).nullish(),
  cwd: z.string().min(1).max(4096).nullish(),
}).strict();
export const sendInputSchema = z.object({
  body: messageBodySchema.optional(), requestId: requestIdSchema.optional(),
  threadId: z.string().uuid().nullish(), eventType: z.enum(MESSAGE_EVENT_TYPES).optional(),
  traceId: z.string().uuid().optional(), causeMessageId: z.string().uuid().optional(),
  recipients: memberNamesSchema.min(1).optional(), attachmentIds: attachmentIdsSchema.optional(),
  executionId: executionIdSchema.optional(),
}).strict();
export const humanSendInputSchema = sendInputSchema.omit({ executionId: true }).extend({
  routing: z.enum([
    "auto",
    "single",
    "brain_one_worker",
    "brain_multi_dm",
    "brain_multi_room",
    "orchestrated_auto",
    "orchestrated",
  ]).optional(),
  lockScope: z.enum(["none", "task", "conversation"]).optional(),
}).strict();
export const channelInputSchema = z.object({ name: nameSchema,
  type: z.enum(["public", "private", "brains"]).optional(), topic: z.string().max(4000).nullish(),
  memberNames: memberNamesSchema.optional(), project: z.string().min(1).max(32).nullish(),
}).strict();
export const reactionInputSchema = z.object({ emoji: z.string().trim().min(1).max(64), present: z.boolean().optional() }).strict();
export const threadResponseSchema = z.object({ id: z.string(), channelId: z.string(),
  status: z.enum(["open", "in_progress", "blocked", "done"]).nullable() }).strict();
export function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Schema diagnostics may contain user input or a credential; publish paths only.
    const fields = [...new Set(result.error.issues.map(issue => issue.path.join(".") || "body"))].slice(0, 6);
    throw new HiveError(400, `Invalid request field: ${fields.join(", ")}`);
  }
  return result.data;
}
export function integerArgument(value: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new HiveError(400, "Expected an unsigned decimal integer");
  return validated(safeInteger.min(minimum).max(maximum), Number(value));
}
export function uploadLength(value: string | null): number | undefined {
  return value === null ? undefined : integerArgument(value, 1, FILE_MAX_BYTES);
}
