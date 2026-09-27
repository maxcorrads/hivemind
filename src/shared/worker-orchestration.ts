import { z } from "zod";
import { taskContractSchema } from "./tasks.ts";

export const launchModeSchema = z.enum(["approval", "auto"]);
export type LaunchMode = z.infer<typeof launchModeSchema>;

export const requestWorkerSchema = z.object({
  requestId: z.string().uuid(),
  template: z.string().trim().min(1).max(100),
  contract: taskContractSchema,
  slug: z.string().trim().min(1).max(100).optional(),
  job: z.object({ title: z.string().trim().min(1).max(240) }).strict().optional(),
  taskId: z.string().uuid().optional(),
  expectedRevision: z.number().int().positive().safe().optional(),
}).strict().refine(value => (value.taskId === undefined) === (value.expectedRevision === undefined),
  { message: "taskId and expectedRevision must be supplied together" });

export const releaseWorkerSchema = z.object({
  worker: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(700),
}).strict();
