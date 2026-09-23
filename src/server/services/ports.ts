import type { Agent, Channel, ControlAction, Message, Project } from "../../shared/types.ts";
import type { HiveBus } from "../hive-events.ts";
import type { Storage } from "../storage.ts";
import type { AdaptiveTopologyRuntime } from "../adaptive-topology.ts";
import type { RoomStore } from "../rooms.ts";
import type { TaskStore } from "../tasks.ts";
import type { IdentityService } from "./identity.ts";
import type { MessageQueries } from "./message-queries.ts";
import type { MessageService } from "./messages.ts";

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

/*
 * Hosts of the coordination sub-stores (tasks, rooms, decisions, timeline, …).
 * Hive still passes itself as their host, but each store is typed against only
 * the slice it uses, so it cannot grow a dependency on the rest of the facade.
 */

export type TaskCoordinationHost = Core & ChannelAccess;
export type CapacityDeps = Core & { readonly identity: Pick<AgentDirectory, "listAgents"> };
export type AdmissionDeps = CapacityDeps & {
  readonly channels: ChannelAccess;
  readonly identity: AgentDirectory;
  readonly rooms: Pick<RoomStore, "peek">;
  readonly adaptiveTopology: AdaptiveTopologyRuntime;
};
export type TaskStoreHost = AdmissionDeps & ChannelAccess & Pick<AgentDirectory, "getAgent" | "getAgentByName"> &
  Pick<MessageReader, "getMessageById" | "getVisibleMessage"> & Pick<MessagePoster, "publishTaskMessage"> & {
    openDm(actor: Agent, otherName: string): Channel;
    readonly rooms: RoomStore;
  };
export type RoomStoreHost = Core & ChannelAccess & AgentDirectory & Pick<MessageReader, "getMessageById" | "getVisibleMessage"> &
  Pick<MessagePoster, "publishTaskMessage"> & { readonly tasks: TaskStore };
export type NotificationHost = Core & ChannelAccess & { readonly rooms: RoomStore };
export type RoutingHost = Core & ChannelAccess & Pick<AgentDirectory, "getAgent"> & Pick<MessagePoster, "postMessage"> & {
  readonly tasks: TaskStore;
};
export type TimelineHost = Core & ChannelAccess & Pick<MessageReader, "getMessageById"> & {
  readonly rooms: RoomStore;
  readonly tasks: TaskStore;
};
export type DecisionHost = Core & ChannelAccess & AgentDirectory & MessageReader & Pick<MessagePoster, "postMessage"> & {
  readonly tasks: TaskStore;
};
export type DiagnosticsHost = { readonly home: string } & Pick<AgentDirectory, "getAgent">;

/** What the adaptive topology runtime reads and writes outside its own tables. */
export type AdaptiveRuntimeDeps = Core & {
  readonly home: string;
  readonly identity: AgentDirectory & Pick<IdentityService, "sessionFingerprint">;
  readonly projects: Pick<ProjectDirectory, "getProject">;
  readonly channels: ChannelAccess;
  readonly messageQueries: Pick<MessageReader, "getMessageById"> & Pick<MessageQueries, "threadStatus">;
  readonly messages: Pick<MessageService, "hasActiveSendRequest" | "postAdaptiveRequest" | "setThreadStatus">;
  readonly rooms: Pick<RoomStore, "peek">;
  readonly tasks: Pick<TaskStore, "get">;
};

/** The brain coordination actions routed through adaptive admission (adaptive-topology-actions.ts). */
export type AdaptiveActionDeps = AdmissionDeps & {
  readonly identity: AgentDirectory & Pick<IdentityService, "agentByToken" | "sessionFingerprint">;
  readonly messageQueries: Pick<MessageReader, "getMessageById"> & Pick<MessageQueries, "threadStatus">;
  readonly messages: Pick<MessageService, "postMessage" | "hasActiveSendRequest" | "setThreadStatus">;
  readonly rooms: Pick<RoomStore, "peek" | "view" | "event">;
  readonly tasks: Pick<TaskStore, "assign" | "event" | "get" | "has">;
};
