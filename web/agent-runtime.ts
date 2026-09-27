import type { AgentWork, TaskState } from "../src/shared/tasks.ts";
import type { Agent } from "../src/shared/types.ts";
import { terminalSessionName } from "../src/shared/terminal-session.ts";
import type { TerminalSessionInfo } from "./native-bridge.ts";
import type { TerminalState } from "./use-terminal.ts";

type AgentIdentity = Pick<Agent, "name" | "project" | "removedAt" | "terminalSession"> &
  Partial<Pick<Agent, "archivedAt">>;
type Roster = { agents: readonly AgentIdentity[] };
export type AgentSessionState = "unknown" | "absent" | "running" | "ended" | "reconnecting";

const STATE_LABEL: Record<TaskState, string> = {
  sent: "assigned", delivered: "assigned", accepted: "working", blocked: "blocked",
  result_submitted: "in review", changes_requested: "changes requested", rejected: "rejected",
  accepted_complete: "done", cancelled: "cancelled", paused: "paused",
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function agentSessionLabel(agent: Pick<Agent, "terminalSession"> | null | undefined): string | null {
  return terminalSessionName(agent?.terminalSession);
}

/** Only one unclaimed, live session recorded for this project and name may stand in for a missing join label. */
export function recordedAgentSession(agent: AgentIdentity, roster: Roster,
  sessions: readonly TerminalSessionInfo[]): TerminalSessionInfo | null {
  if (!agent.project || agent.removedAt !== undefined || agent.archivedAt !== undefined) return null;
  const claimed = new Set(roster.agents.map(agentSessionLabel).filter(Boolean));
  const matches = sessions.filter(session => session.alive && session.project === agent.project &&
    session.agent?.toLowerCase() === agent.name.toLowerCase() && !claimed.has(session.name));
  return matches.length === 1 ? matches[0]! : null;
}

/** Native Stop requires a connected broker and one live session owned by the current name or a server-owned alias. */
export function verifiedStopSession(agent: Agent, agents: readonly Agent[], terminals: TerminalState,
  resumeAliases: readonly string[] = []): string | null {
  if (!terminals.native || terminals.broker !== 'connected' || !terminals.sessions || !agent.project ||
      agent.removedAt !== undefined || agent.archivedAt !== undefined) return null;
  const names = new Set([agent.name, ...resumeAliases].map(name => name.toLowerCase()));
  const label = agentSessionLabel(agent);
  const matches = terminals.sessions.filter(session => session.alive && session.project === agent.project &&
    session.agent && names.has(session.agent.toLowerCase()) && (!label || session.name === label));
  if (matches.length !== 1) return null;
  const session = matches[0]!;
  if (agents.some(other => other.id !== agent.id && other.project === agent.project &&
      other.terminalSession === session.name && other.removedAt === undefined && other.archivedAt === undefined)) return null;
  return session.name;
}

function statusLine(agent: Agent, work?: AgentWork): string | null {
  if (agent.role === "human" || agent.role === "bot") return null;
  if (agent.pending) return "starting…";
  let detail: string | null = null;
  if (work?.task) {
    const { state, needed, objective } = work.task;
    const more = work.assigned > 1 ? ` (+${work.assigned - 1} more)` : "";
    detail = `${STATE_LABEL[state]}: ${state === "blocked" && needed ? needed : objective}${more}`;
  } else if (work?.toReview) detail = `reviewing ${plural(work.toReview, "result")}`;
  else if (work?.delegated) detail = `coordinating ${plural(work.delegated, "task")}`;

  const activity = agent.activity;
  if (activity?.state === "stalled" || activity?.state === "superseded")
    return `${activity.state}${activity.hint ? `: ${activity.hint}` : detail ? ` · ${detail}` : ""}`;
  if (activity?.state === "offline") return detail ? `offline · ${detail}` : "offline";
  return detail ?? (activity?.state ?? (agent.online ? "idle" : "offline"));
}

/** One pure projection for the roster, DMs, and terminal sheet. Broker state never defines server activity. */
export function agentRuntime(agent: Agent | null | undefined, snapshot: Roster | null | undefined,
  terminals: TerminalState, work?: AgentWork) {
  const activity = agent?.activity;
  if (!agent || !terminals.native || terminals.broker === "unverified" || agent.removedAt !== undefined ||
      agent.archivedAt !== undefined) {
    return { sessionName: null, session: null, sessionState: "unknown" as AgentSessionState,
      activity, statusLine: agent ? statusLine(agent, work) : null };
  }
  const known = terminals.broker === "connected" && terminals.sessions !== null;
  const sessions = known ? terminals.sessions : terminals.lastKnownSessions ?? null;
  const label = agentSessionLabel(agent);
  const fallback = !label && sessions ? recordedAgentSession(agent, snapshot ?? { agents: [agent] }, sessions) : null;
  const sessionName = label ?? fallback?.name ?? null;
  const session = sessions?.find(item => item.name === sessionName) ?? null;
  const sessionState: AgentSessionState = known
    ? session?.alive ? "running" : session ? "ended" : "absent"
    : sessionName && (sessions !== null || terminals.broker === "unavailable") ? "reconnecting" : "unknown";
  return { sessionName, session: known ? session : null, sessionState, activity, statusLine: statusLine(agent, work) };
}
