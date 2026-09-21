import { setCapabilitiesSchema, suggestWorkersSchema, routingOutcomeSchema, routingOverrideSchema } from '../shared/routing.ts';
import { z } from "zod";
import { readLimitedJson } from "./ingress.ts";
import { API_JSON_BYTES, channelInputSchema, cursorSchema, integerArgument,
  humanSendInputSchema, joinInputSchema, memberNamesSchema, nameSchema, reactionInputSchema, referenceSchema, sendInputSchema,
  sequenceSchema, validated, waitDurationSchema } from "../shared/api-contract.ts";
import { subscriptionSchema, subscriptionScopeSchema } from "../shared/notifications.ts";
import { claimPreviewSchema } from '../shared/task-claims.ts';
import { assignTaskSchema, taskEventSchema } from "../shared/tasks.ts";
import { decisionAnswerSchema, decisionEventSchema, requestDecisionSchema } from "../shared/decisions.ts";
import { roomEventSchema, sourceLinkSchema, sourceReportSchema } from "../shared/rooms.ts";
import { HiveError } from "../shared/types.ts";

const empty = z.object({}).strict();
const destination = z.object({ name: nameSchema.optional(), to: nameSchema.optional(),
  agent: nameSchema.optional() }).strict().refine(v => [v.name, v.to, v.agent].filter(Boolean).length === 1);
const invite = z.object({ names: memberNamesSchema.optional(), name: nameSchema.optional(), member: nameSchema.optional() })
  .strict().refine(v => [v.names, v.name, v.member].filter(v => v !== undefined).length === 1);
const project = z.object({ name: z.string().trim().min(1).max(160), slug: z.string().min(1).max(32).optional(),
  worktree: z.string().min(1).max(4096).nullish() }).strict();
const read = z.object({ channelId: referenceSchema, threadId: z.string().uuid().nullish(),
  messageSeqs: z.array(sequenceSchema).max(200).optional(), seq: sequenceSchema.optional() }).strict()
  .refine(v => (v.messageSeqs !== undefined) !== (v.seq !== undefined));
const expand = z.object({ channel: referenceSchema, messageIds: z.array(z.string().uuid()).max(100).min(1),
  afterSeq: cursorSchema.optional() }).strict();
const wait = z.object({ sessionId: z.string().uuid().optional(), compact: z.boolean().optional(), timeoutMs: waitDurationSchema.optional() }).strict();
const join = joinInputSchema.extend({ resume: nameSchema.nullish() });
const telegramId = z.union([z.number().int().safe(), z.string().regex(/^-?[0-9]+$/)]);
const telegram = z.object({ botToken: z.string().max(512).optional(),
  projects: z.record(z.string().max(32), z.union([telegramId, z.object({ groupChatId: telegramId }).strict()]))
    .refine(value => Object.keys(value).length <= 128).optional(),
  allowUserIds: z.union([z.array(telegramId).max(128), z.string().max(4096)]).optional(),
}).strict();

function schemaFor(path: string, method: string): z.ZodType | undefined {
  if (path.endsWith('/api/agent/join')) return join;
  if (/\/channels\/[^/]+\/messages$/.test(path)) {
    if (path.startsWith('/api/bot/')) return undefined;
    return path.startsWith('/api/ui/') ? humanSendInputSchema : sendInputSchema;
  }
  if (path.endsWith('/channels')) return channelInputSchema;
  if (/\/messages\/[^/]+\/reactions$/.test(path)) return reactionInputSchema;
  if (/\/(?:dms|clear-context)$/.test(path)) return destination;
  if (/\/channels\/[^/]+\/invite$/.test(path)) return invite;
  if (/\/threads\/[^/]+\/status$/.test(path)) return z.object({ status: z.enum(['open','in_progress','blocked','done']).nullable() }).strict();
  if (path.endsWith('/api/ui/projects')) return project;
  if (/\/api\/ui\/projects\/[^/]+$/.test(path) && method === 'PATCH') return project.pick({ name: true, worktree: true }).partial();
  if (path === '/api/ui/telegram') return telegram;
  if (path === '/api/ui/read') return read;
  if (path === '/api/ui/mentions/seen') return z.object({ project: z.string().min(1).max(32).optional() }).strict();
  if (path === '/api/agent/wait') return wait;
  if (path === '/api/agent/inbox/session') return z.object({ sessionId: z.string().uuid() }).strict();
  if (path === '/api/agent/inbox/ack') return z.object({ sessionId: z.string().uuid(), deliveryId: z.string().uuid() }).strict();
  if (path.endsWith('/messages/expand')) return expand;
  if (path.endsWith('/subscriptions')) return subscriptionSchema;
  if (path.endsWith('/subscriptions/reset')) return subscriptionScopeSchema;
  if (/\/tasks\/[^/]+\/claim-preview$/.test(path)) return claimPreviewSchema;
  if (path.endsWith('/capabilities')) return setCapabilitiesSchema;
  if (/\/tasks\/[^/]+\/routing$/.test(path)) return suggestWorkersSchema;
  if (/\/tasks\/[^/]+\/routing-outcome$/.test(path)) return routingOutcomeSchema;
  if (/\/tasks\/[^/]+\/routing-override$/.test(path)) return routingOverrideSchema;
  if (path.endsWith('/tasks')) return assignTaskSchema;
  if (/\/tasks\/[^/]+\/events$/.test(path)) return taskEventSchema;
  if (path.endsWith('/api/agent/decisions')) return requestDecisionSchema;
  if (/\/api\/agent\/decisions\/[^/]+\/events$/.test(path)) return decisionEventSchema;
  if (/\/api\/ui\/decisions\/[^/]+\/answer$/.test(path)) return decisionAnswerSchema;
  if (/\/channels\/[^/]+\/room$/.test(path)) return roomEventSchema;
  if (/\/channels\/[^/]+\/links$/.test(path)) return sourceLinkSchema;
  if (/\/channels\/[^/]+\/links\/[^/]+\/status$/.test(path)) return sourceReportSchema;
  if (/\/(?:ping|leave)$/.test(path) || /\/(?:retry|discard)$/.test(path)) return empty;
  // Bot/plugin/recovery schemas have their own narrower ingress readers.
  return undefined;
}
let readingBodies = 0;
const cache = new WeakMap<Request, Record<string, unknown>>();
// Fields are validated using the route-specific shared schema before handlers
// normalize legacy aliases. This helper is the only dynamic route dispatcher.
export async function requestJson(request: Request): Promise<Record<string, any>> {
  const existing = cache.get(request); if (existing) return existing;
  const schema = schemaFor(new URL(request.url).pathname, request.method);
  if (!schema) throw new HiveError(400, "No JSON contract for this endpoint");
  if (readingBodies >= 32) throw new HiveError(429, 'Too many JSON bodies in progress');
  let value: unknown;
  readingBodies++;
  try {
    const emptyAllowed = schema === empty || new URL(request.url).pathname === '/api/ui/mentions/seen';
    value = emptyAllowed && !request.body ? {} : await readLimitedJson(request, API_JSON_BYTES, 10_000, emptyAllowed);
  } finally { readingBodies--; }
  const parsed = validated(schema, value) as Record<string, unknown>;
  cache.set(request, parsed); return parsed;
}
export async function validateRequest(request: Request): Promise<void> {
  const { pathname, searchParams } = new URL(request.url);
  for (const key of ['limit', 'before', 'beforeSeq', 'afterSeq']) {
    const values = searchParams.getAll(key);
    if (values.length > 1) throw new HiveError(400, `Repeated ${key}`);
    if (values.length) integerArgument(values[0]!, key === 'limit' ? 1 : 0);
  }
  for (const key of ['meta', 'unread', 'orders', 'includeClosed']) {
    const values = searchParams.getAll(key);
    if (values.length > 1 || values.some(value => !['0','1'].includes(value))) throw new HiveError(400, `Invalid ${key}`);
  }
  const seq = /\/messages\/([^/]+)(?:\/reactions)?$/.exec(pathname)?.[1];
  if (seq && seq !== 'expand') integerArgument(seq, 1);
  if (searchParams.has('beforeTask')) validated(z.string().uuid(), searchParams.get('beforeTask'));
  if (searchParams.has('threadId')) validated(z.string().uuid(), searchParams.get('threadId'));
  if (searchParams.has('q')) validated(z.string().max(4000), searchParams.get('q'));
  if (['POST','PUT','PATCH'].includes(request.method) && schemaFor(pathname, request.method)) await requestJson(request);
}
