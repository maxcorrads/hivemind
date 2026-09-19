import { z } from "zod";
import { BODY_MAX, FILES_PER_MESSAGE, MESSAGE_EVENT_TYPES } from "./types.ts";

export const createBotSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, "Use 1–40 letters, digits, underscores or dashes, starting with a letter"),
}).strict();

const label = z.string().trim().min(1).max(200);
export const botCredentialSchema = z.object({
  action: z.enum(['rotate', 'revoke']),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
}).strict();

export const botMessageSchema = z.object({
  eventId: z.string().trim().min(1).max(240),
  body: z.string().trim().max(BODY_MAX).default(""),
  eventType: z.enum(MESSAGE_EVENT_TYPES).optional(),
  attachmentIds: z.array(z.string().min(1).max(200)).max(FILES_PER_MESSAGE).default([]),
  threadId: z.string().min(1).max(200).nullable().optional(),
  origin: z.object({
    label: label.optional(),
    author: label.optional(),
    url: z.string().max(2048).url().refine((value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    }, "Use an HTTP(S) link without credentials").optional(),
    occurredAt: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
  }).strict().optional(),
}).strict()
  .refine((input) => Boolean(input.body || input.attachmentIds.length), "A body or an attachment is required")
  .refine((input) => new Set(input.attachmentIds).size === input.attachmentIds.length, "Duplicate attachment IDs");
