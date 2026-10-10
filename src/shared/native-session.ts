import { z } from 'zod';

/** Host-reported launch metadata, NOT credentials, process evidence or task authority. */
export const nativeSessionSchema = z.object({
  software: z.enum(['codex', 'claude', 'cursor']),
  sessionId: z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).nullable(),
  model: z.string().max(160).regex(/^(?:[A-Za-z0-9][A-Za-z0-9._:+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:+-]*)?)?$/),
  effort: z.enum(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
}).strict().refine(value => value.sessionId === null || value.software === 'cursor' || z.string().uuid().safeParse(value.sessionId).success,
  'Codex and Claude require a conversation UUID');

export type NativeSession = z.infer<typeof nativeSessionSchema>;

/** Never use a name, --last, a transcript path or another provider's ID as a fallback. */
export function nativeSessionId(value: string, software: NativeSession['software'] = 'codex'): string {
  const schema = software === 'cursor' ? z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/) : z.string().uuid();
  const parsed = schema.safeParse(value.trim());
  if (!parsed.success) throw new Error('Native resume needs the exact conversation UUID or Cursor chat ID');
  return parsed.data;
}
