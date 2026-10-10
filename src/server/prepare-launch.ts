import { validated } from '../shared/api-contract.ts';
import { prepareLaunchSchema, type LaunchSettings } from '../shared/launch-settings.ts';
import { buildLaunchCommand, projectLaunchTools, softwareFamily, type LaunchInput } from '../shared/launch-prompt.ts';
import { HiveError, type Agent, type Project } from '../shared/types.ts';
import type { Hive } from './hive.ts';
import { launchContext } from './bot-definitions.ts';
import type { LaunchSessions } from './launch-sessions.ts';

export function trackedLaunch(deps: { home: string; launchSessions: LaunchSessions }, url: string, project: Project,
  settings: LaunchSettings, agent: Agent | null,
  { requireBotContext = false, ...options }: Pick<LaunchInput, 'claim' | 'claimName' | 'nativeResume'> & { requireBotContext?: boolean } = {}) {
  const context = launchContext(deps.home, url, project);
  // Manual workers need only the MCP binding, not bot instructions. The task
  // queue retains its stricter project-readiness gate as an explicit policy.
  if (context.botError && (settings.role === 'brain' || requireBotContext))
    throw new HiveError(503, 'Project launch context is unavailable');
  const input: LaunchInput = { ...settings, ...projectLaunchTools(context, project, settings.role),
    projectSlug: project.slug, hiveName: project.name, resume: Boolean(agent && !options.claim),
    resumeName: agent?.name, ...options };
  try { buildLaunchCommand(input); }
  catch { throw new HiveError(400, 'Invalid launch configuration or conflicting native session selectors'); }
  const tracking = deps.launchSessions.prepare(project.id, settings, agent?.id ?? null, options.nativeResume?.sessionId);
  try { return { ...buildLaunchCommand({ ...input, tracking }), environment: settings.environment }; }
  catch { throw new HiveError(400, 'Invalid tracked launch configuration or conflicting native session selectors'); }
}

export function prepareHumanLaunch(hive: Hive, url: string, raw: unknown) {
  const input = validated(prepareLaunchSchema, raw), project = hive.projects.getProjectBySlug(input.project);
  const agent = input.agentId ? hive.identity.getAgent(input.agentId) : null;
  if (agent && (agent.projectId !== project.id || agent.role !== input.settings.role ||
    agent.removedAt !== undefined || agent.archivedAt !== undefined || agent.online ||
    (input.claim ? !agent.pending || !agent.templateId : agent.pending || agent.templateId)))
    throw new HiveError(409, 'Agent cannot resume here; stop its session or use its task controls');
  if (input.native && !agent) throw new HiveError(400, 'Native resume requires an existing employee');
  if (input.claim && (!agent || input.native)) throw new HiveError(400, 'Claim launch requires a reserved employee');
  const family = softwareFamily(input.settings.software);
  if (input.native && !['codex', 'claude', 'cursor'].includes(family)) throw new HiveError(400, 'This client has no native resume adapter');
  return hive.storage.transaction(() => trackedLaunch(hive, url, project, input.settings, agent, input.native
    ? { nativeResume: { software: family as 'codex' | 'claude' | 'cursor', sessionId: input.sessionId ?? '' } }
    : input.claim ? { claim: input.claim, claimName: agent!.name } : {}));
}
