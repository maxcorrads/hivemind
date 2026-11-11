import type { Agent, Channel, ControlAction, Message, Project } from "../../shared/types.ts";
import type { HiveBus } from "../hive-events.ts";
import type { Storage } from "../storage.ts";
import type { RoomStore } from "../rooms.ts";
import type { TaskStore } from "../tasks.ts";
import type { NotificationStore } from "../notifications.ts";
import type { ChannelService } from "./channels.ts";
import type { IdentityService } from "./identity.ts";
import type { MessageQueries } from "./message-queries.ts";
import type { MessageService } from "./messages.ts";
import type { BotService } from "./bots.ts";
import type { LauncherQueue } from "../launcher-queue.ts";
import type { WorkerOrchestration } from "./worker-orchestration.ts";

/**
 * Narrow interfaces the domain services (and the sub-stores) depend on instead of
 * the whole Hive. Hive wires one registry object that satisfies every service's
 * dependency type; services read peers from it lazily (at call time), so peers
 * constructed later, and mutual dependencies, resolve without runtime imports.
 * This module is type-only: importing it never loads another module.
 */

/** The shared unit of work and the post-commit event bus. */
export type Core = { readonly storage: Storage; readonly bus: HiveBus };

/**
 * Agent lookups. Removed agents (#215) stay readable by id, for history, but are left out of name lookups and the
 * roster, so they can no longer be addressed, mentioned or assigned.
 */
export interface AgentDirectory {
  getAgent(id: string): Agent;
  findAgent(id: string): Agent | null;
  /** The agent when it exists and was not removed. */
  findActiveAgent(id: string): Agent | null;
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
 * Dependencies of the coordination sub-stores (tasks, rooms, timeline, …).
 * Hive hands each store the same service registry it gives the services; each store
 * sees only the slice it declares here, so it cannot grow a dependency on the rest.
 */

type Channels<K extends keyof ChannelAccess = keyof ChannelAccess> = { readonly channels: Pick<ChannelAccess, K> };
type Agents<K extends keyof AgentDirectory = keyof AgentDirectory> = { readonly identity: Pick<AgentDirectory, K> };
type Messages<K extends keyof MessageReader = keyof MessageReader> = { readonly messageQueries: Pick<MessageReader, K> };
type Poster<K extends keyof MessagePoster> = { readonly messages: Pick<MessagePoster, K> };

/** Channel id sets that coordination queries filter their own tables by. */
type ChannelScopes<K extends "channelIdsIn" | "memberChannelIds" = "channelIdsIn"> = {
  readonly channels: Pick<ChannelService, K>;
};

export type TaskCoordinationDeps = Core & Channels & ChannelScopes;
/** Coordination records insert their own message (and thread root) inside their transaction. */
type CoordinationWriter<K extends "insertCoordinationMessage" | "ensureThread"> = { readonly messages: Pick<MessageService, K> };

export type TaskStoreDeps = TaskCoordinationDeps & Agents & Messages<"getMessageById" | "getVisibleMessage"> &
  Poster<"publishTaskMessage"> & CoordinationWriter<"insertCoordinationMessage" | "ensureThread"> & {
    readonly messages: Pick<MessageService, "moveTaskThread">;
    readonly launcherQueue: Pick<LauncherQueue, "createResume">;
    readonly workerOrchestration: Pick<WorkerOrchestration, "archiveFinishedTask" | "stopForHardPause" | "retryHardStop">;
    readonly jobs?: { syncForTask(taskId: string): void };
    readonly channels: { openDm(actor: Agent, otherName: string): Channel };
    readonly messageQueries: Pick<MessageQueries, "hasNewerInThread">;
    readonly rooms: RoomStore;
  };
export type RoomStoreDeps = Core & Channels & Agents & Messages<"getMessageById" | "getVisibleMessage"> &
  Poster<"publishTaskMessage"> & CoordinationWriter<"insertCoordinationMessage"> & {
    readonly tasks: Pick<TaskStore, "get" | "control">;
    readonly bots: Pick<BotService, "access">;
  };
export type NotificationDeps = Core & Channels<"getChannel" | "canSeeChannel"> & {
  readonly messageQueries: Pick<MessageQueries, "messageRef">;
  readonly rooms: Pick<RoomStore, "peek">;
};
export type RoutingDeps = Core & Channels & ChannelScopes<"channelIdsIn" | "memberChannelIds"> & Agents<"getAgent"> &
  Poster<"postMessage"> & {
    readonly channels: Pick<ChannelService, 'openDm'>;
    readonly identity: Pick<IdentityService, "projectWorkerIds">;
    readonly tasks: Pick<TaskStore, "get">;
    readonly lifecycleLog?: { record(input: { agentId: string; projectId: string | null; actorId: string | null;
      kind: 'capability_edited'; summary: string; source: 'server' }): unknown };
  };
export type TimelineDeps = Core & Channels<"getChannel" | "canSeeChannel"> & Messages<"getMessageById"> & {
  readonly messageQueries: Pick<MessageQueries, "messageRef" | "wakeHeader" | "traceMessages" | "postedByBot" | "seqsOf">;
  readonly identity: Pick<IdentityService, "findAgent">;
  readonly notifications: Pick<NotificationStore, "subscribedEventTypes">;
  readonly rooms: Pick<RoomStore, "peek">;
  readonly tasks: Pick<TaskStore, "get" | "unfinished">;
};

/** An agent's send: validated, answered from its requestId when retried, then posted (agent-send.ts). */
export type AgentSendDeps = Channels & Messages<"getMessageById"> & {
  readonly messages: Pick<MessageService, "postMessage" | "hasActiveSendRequest">;
};
