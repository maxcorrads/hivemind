import { z } from "zod";
import { EFFORTS, sanitizeExtraFlags, sanitizeModel, sanitizeSoftware } from "./launch-prompt.ts";
import { launchEnvironmentNameProblem, launchEnvironmentProblem } from "./launch-environment.ts";

/**
 * Worker templates (docs/agent-management-roadmap.md, Phase A1): the workers Human allows brains of a project to
 * launch. A template holds everything a launch needs except its secret values, which live only in Hivemind
 * Server.app's Keychain; the server keeps their names.
 */
export const WORKER_TEMPLATE_LIMITS = Object.freeze({ perProject: 32, secrets: 8, maxConcurrent: 8 });

export const workerTemplateSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/,
  "a slug is 1-32 lowercase letters, digits and -, starting with a letter or digit");

/** Runs one of launch-prompt's sanitizers as a refinement, reporting its message. */
const sanitized = (sanitize: (raw: string) => string) => (value: string, ctx: z.RefinementCtx) => {
  try { sanitize(value); } catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); }
};

/** A secret's name: an environment variable name the launch may set, OPENCODE_API_KEY included. */
export function workerSecretNameProblem(name: string): string | null {
  if (name.toUpperCase() === "OPENCODE_API_KEY") return name === "OPENCODE_API_KEY" ? null : "write OPENCODE_API_KEY in capitals";
  return launchEnvironmentNameProblem(name);
}

export const workerTemplateSpecSchema = z.object({
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  software: z.string().trim().min(1).max(200).superRefine(sanitized(sanitizeSoftware)),
  model: z.string().trim().max(200).superRefine(sanitized(sanitizeModel)),
  effort: z.union([z.literal(""), z.enum(EFFORTS)]),
  extraFlags: z.string().max(1000).superRefine(sanitized(sanitizeExtraFlags)),
  environment: z.record(z.string(), z.string()).superRefine((environment, ctx) => {
    const problem = Object.keys(environment).length ? launchEnvironmentProblem(environment) : null;
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }),
  secretNames: z.array(z.string()).max(WORKER_TEMPLATE_LIMITS.secrets).superRefine((names, ctx) => {
    if (new Set(names.map(name => name.toUpperCase())).size !== names.length) ctx.addIssue({ code: "custom", message: "a secret is named twice" });
    for (const name of names) {
      const problem = workerSecretNameProblem(name);
      if (problem) ctx.addIssue({ code: "custom", message: `${name}: ${problem}` });
    }
  }),
  seniority: z.enum(["junior", "mid", "senior"]),
  focus: z.string().trim().max(80),
  maxConcurrent: z.number().int().min(1).max(WORKER_TEMPLATE_LIMITS.maxConcurrent),
  enabled: z.boolean(),
}).strict().superRefine((spec, ctx) => {
  const variables = new Set(Object.keys(spec.environment).map(name => name.toUpperCase()));
  for (const name of spec.secretNames) {
    if (variables.has(name.toUpperCase())) ctx.addIssue({ code: "custom", path: ["secretNames"], message: `${name} is both a secret and an environment variable` });
  }
});

export const createWorkerTemplateSchema = z.object({ slug: workerTemplateSlugSchema, spec: workerTemplateSpecSchema }).strict();
export const updateWorkerTemplateSchema = z.object({
  expectedRevision: z.number().int().positive().safe(),
  slug: workerTemplateSlugSchema.optional(),
  spec: workerTemplateSpecSchema,
}).strict();

export type WorkerTemplateSpec = z.infer<typeof workerTemplateSpecSchema>;

export type WorkerTemplate = {
  id: string;
  projectId: string;
  slug: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  spec: WorkerTemplateSpec;
};
