import { EventEmitter } from "node:events";
import type { Agent, Channel, InboxStatus, Message, QueueEstimate, Thread } from "../shared/types.ts";
import type { TaskSnapshot } from "../shared/tasks.ts";
import type { DecisionView } from "../shared/decisions.ts";
import type { AdaptiveExecutionState, AdaptiveRoutingEvent } from "../shared/adaptive-topology.ts";
import type { JevCallSummary } from "../shared/jev-calls.ts";
import type { Hive } from "./hive.ts";
import type { Storage } from "./storage.ts";

/** Telegram delivery and polling health as published to the UI. */
export type TelegramHealthEvent = ReturnType<Hive["telegramHealth"]>;

/**
 * Every event published on `Hive.bus`, keyed by name, with its payload type.
 * Most are forwarded verbatim to the web UI's realtime stream by serve.ts; the
 * `telegram-*-wake` signals are server-internal. HiveBus defers every emit made
 * inside a transaction until the outermost commit (see storage.ts), so
 * subscribers may read the database immediately and never see rolled-back state.
 */
export type HiveEvents = {
  /** A message (chat, system, control or structured task/room/decision event) was committed. */
  message: Message;
  /** An agent joined, changed presence, or a bot was created: the current Agent row. */
  agent: Agent;
  /** A channel was created or its membership/metadata changed (including task-driven changes). */
  channel: Channel;
  /** A thread's status was set or cleared. */
  thread: Thread;
  /** A reaction was toggled: the message's seq and its Human-decorated view. */
  reaction: { seq: number; message: Message };
  /** A brain/worker inbox estimate changed after new mail or an acknowledgement. */
  queued: { agentId: string; n: number; inbox: InboxStatus & { queued: QueueEstimate } };
  /** A project was deleted (`deleted`: slug) or an agent was removed from the hive (`removed`: name). */
  project: { deleted: string } | { removed: string };
  /** Telegram health changed (only published when the status differs from the last broadcast). */
  "telegram-health": TelegramHealthEvent;
  /** A quarantined Telegram update was retried or discarded; the inbound retry pump should run. */
  "telegram-inbox-wake": void;
  /** A failed Telegram delivery was re-queued; the outbound dispatcher should run. */
  "telegram-outbox-wake": void;
  /** A task was assigned, changed state, or recorded a delivery receipt: its Human view. */
  task: TaskSnapshot;
  /** A room's link or state changed; clients refetch the room for `channelId`. */
  room: { channelId: string };
  /** A Human decision request was created, answered, withdrawn or superseded: its view. */
  decision: DecisionView;
  /** Adaptive routing recorded an event for a channel; `state` is null when no execution is displayed. */
  "adaptive-routing": { channelId: string; state: AdaptiveExecutionState | null; event: AdaptiveRoutingEvent };
  /** A Jev call was recorded or settled in the call log. */
  "jev-call": JevCallSummary;
};

type EventMap = { [event: string]: unknown };
export type EventListener<P> = (payload: P) => void;
type EventArgs<P> = [P] extends [void] ? [] : [payload: P];

/** A type-checked facade over node:events: event names and payloads come from `Events`. */
export class TypedEmitter<Events extends EventMap> {
  readonly #emitter = new EventEmitter();

  constructor(maxListeners?: number) {
    if (maxListeners !== undefined) this.#emitter.setMaxListeners(maxListeners);
  }

  on<K extends keyof Events & string>(event: K, listener: EventListener<Events[K]>): this {
    this.#emitter.on(event, listener);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: EventListener<Events[K]>): this {
    this.#emitter.once(event, listener);
    return this;
  }

  off<K extends keyof Events & string>(event: K, listener: EventListener<Events[K]>): this {
    this.#emitter.off(event, listener);
    return this;
  }

  emit<K extends keyof Events & string>(event: K, ...args: EventArgs<Events[K]>): boolean {
    return this.#emitter.emit(event, ...args);
  }

  listenerCount(event: keyof Events & string): number {
    return this.#emitter.listenerCount(event);
  }

  /** Total listeners across every event; used to detect subscribers that outlive their owner. */
  totalListenerCount(): number {
    return this.#emitter.eventNames().reduce((sum, event) => sum + this.#emitter.listenerCount(event), 0);
  }

  removeAllListeners(event?: keyof Events & string): this {
    this.#emitter.removeAllListeners(event);
    return this;
  }

  getMaxListeners(): number {
    return this.#emitter.getMaxListeners();
  }
}

/**
 * Per-event listener budget for `Hive.bus`. Production peaks at three listeners per
 * event (the web socket fan-out in serve.ts, the running Telegram bridge, and a
 * draining bridge's capture during reload); the rest is headroom for tests that
 * observe events. Node warns (MaxListenersExceededWarning) past this, which is how
 * a subscriber that is never removed on stop/reconnect shows up.
 */
export const HIVE_BUS_MAX_LISTENERS = 10;

export class HiveBus extends TypedEmitter<HiveEvents> {
  #storage: Storage | undefined;
  constructor() { super(HIVE_BUS_MAX_LISTENERS); }

  /**
   * Routes every emit through `storage.afterCommit`: inside a transaction the event
   * waits for the outermost commit (and is dropped on rollback); outside one it is
   * delivered synchronously as before. Hive binds its own storage at construction.
   */
  bindStorage(storage: Storage): void {
    this.#storage = storage;
  }

  override emit<K extends keyof HiveEvents & string>(event: K, ...args: EventArgs<HiveEvents[K]>): boolean {
    const storage = this.#storage;
    if (!storage?.active) return super.emit(event, ...args);
    storage.afterCommit(() => { super.emit(event, ...args); });
    return this.listenerCount(event) > 0;
  }
}
