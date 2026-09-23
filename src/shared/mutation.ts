import { z } from "zod";

export const requestIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);
export const executionIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/)
  .describe('Deprecated and ignored (#211); accepted only for older clients.');
export const SEND_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SEND_KEYS_PER_ACTOR = 10_000;
export const SEND_KEYS_TOTAL = 100_000;
