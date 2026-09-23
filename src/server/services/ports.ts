import type { Agent, Channel, ControlAction, Message, Project } from "../../shared/types.ts";
import type { HiveBus } from "../hive-events.ts";
import type { Storage } from "../storage.ts";

/**
 * Narrow interfaces the domain services (and the sub-stores) depend on instead of
 * the whole Hive. Hive wires one registry object that satisfies every service's
 * dependency type; services read peers from it lazily (at call time), so peers
 * constructed later, and mutual dependencies, resolve without runtime imports.
 * This module is type-only: importing it never loads another module.
 */

/** The shared unit of work and the post-commit event bus. */
export type Core = { readonly storage: Storage; readonly bus: HiveBus };

export interface AgentDirectory {
  getAgent(id: string): Agent;
  getAgentByName(name: string): Agent | null;
  listAgents(viewer?: Agent): Agent[];
}

export interface ProjectDirectory {
  listProjects(): Project[];
  getProject(id: string): Project;
  getProjectBySlug(slug: string): Project;
  /** Resolves the project an actor may act in (Human must name one; agents are pinned to theirs). */
  requireActorProject(actor: Agent, projectRef?: string | null): Project;
}

export interface ChannelAccess {
  getChannel(idOrName: string, projectId?: string | null): Channel;
  canSeeChannel(actor: Agent, ch: Channel): boolean;
  canPost(actor: Agent, ch: Channel): boolean;
}

export interface MessageReader {
  getMessageById(id: string): Message;
  getMessageBySeq(seq: number): Message;
  getVisibleMessage(actor: Agent, seq: number): Message;
}

export type PostMessageInput = {
  channel: string;
  body: string;
  requestId?: string;
  threadId?: string | null;
  kind?: Message["kind"];
  eventType?: Message["eventType"];
  control?: ControlAction | null;
  source?: "hive" | "telegram";
  traceId?: string;
  causeMessageId?: string;
  attachmentIds?: string[];
  recipients?: string[];
};

export interface MessagePoster {
  postMessage(actor: Agent, input: PostMessageInput, persistReceipt?: (message: Message) => void): Message;
  /** Posts a Human system notice; failures (e.g. during bootstrap) are swallowed. */
  postSystem(channelId: string, body: string): void;
  /** Publishes a committed structured-event message and wakes its recipients. */
  publishTaskMessage(message: Message): void;
}

/** Long-poll waiters, keyed by agent: presence and project deletion consult them. */
export interface WaiterRegistry {
  has(agentId: string): boolean;
  supersede(agentId: string): void;
}
