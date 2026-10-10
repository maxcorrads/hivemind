import { z } from 'zod';
import { sanitizeSoftware, sanitizeModel, sanitizeEffort, sanitizeExtraFlags, sanitizeWorkspacePath, type LaunchInput } from './launch-prompt.ts';
import { launchEnvironmentProblem } from './launch-environment.ts';

const sanitized = (fn: (value: string) => string, max = 4096) => z.string().max(max).transform((value, ctx) => {
  try { return fn(value); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid launch setting' }); return z.NEVER; }
});

/** Human-selected configuration, not model telemetry. Keychain/API-key fields are excluded;
 * arbitrary environment values can still be sensitive and are encrypted at rest. */
export const launchSettingsSchema = z.object({
  software: sanitized(sanitizeSoftware), model: sanitized(sanitizeModel, 160), effort: sanitized(sanitizeEffort),
  extraFlags: sanitized(sanitizeExtraFlags), workspacePath: sanitized(sanitizeWorkspacePath).nullable(),
  cdWorktree: z.boolean(), passProject: z.boolean(), adoptUntrusted: z.boolean(),
  role: z.enum(['brain', 'worker']), seniority: z.enum(['junior', 'mid', 'senior']).nullable(),
  focus: z.string().max(4000).nullable(),
  environment: z.record(z.string(), z.string()).superRefine((value, ctx) => {
    if (Object.keys(value).length && launchEnvironmentProblem(value)) ctx.addIssue({ code: 'custom', message: 'Invalid environment' });
  }),
}).strict();
export type LaunchSettings = z.infer<typeof launchSettingsSchema>;
export type SavedLaunch = { settings: LaunchSettings; sessionId: string | null; captured: boolean };
export const prepareLaunchSchema = z.object({
  project: z.string().min(1).max(32), agentId: z.string().uuid().optional(), settings: launchSettingsSchema,
  native: z.boolean().default(false), sessionId: z.string().max(128).optional(),
  claim: z.string().regex(/^hmc_[0-9a-f]{48}$/).optional(),
}).strict();
export type PrepareLaunch = z.input<typeof prepareLaunchSchema>;

export const launchTicketSchema = z.string().regex(/^hml_[a-f0-9]{64}$/);

export function settingsForLaunch(input: LaunchInput, environment: Record<string, string>): LaunchSettings {
  return { software: input.software, model: input.model ?? '', effort: input.effort ?? '', extraFlags: input.extraFlags ?? '',
    workspacePath: input.workspacePath, cdWorktree: input.cdWorktree, passProject: input.passProject,
    adoptUntrusted: input.adoptUntrusted, role: input.role, seniority: input.role === 'worker' ? input.seniority ?? null : null,
    focus: input.focus ?? null, environment };
}
