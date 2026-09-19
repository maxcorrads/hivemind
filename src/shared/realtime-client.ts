export type RealtimeEvent = {
  type: string;
  payload: unknown;
  streamId?: string;
  sequence?: number;
};

/** Schedules asynchronous work and returns an idempotent cancellation function. */
export type Defer = (run: () => void) => () => void;

/** An ordering envelope, not a durable replay cursor or an HTTP snapshot version. */
export function createRealtimeStream(streamId: string) {
  if (!streamId) throw new Error("A realtime stream needs an instance ID");
  let sequence = 0;
  return {
    hello: (): RealtimeEvent => ({ type: "hello", payload: null, streamId, sequence }),
    event: (type: string, payload: unknown): RealtimeEvent => {
      sequence += 1;
      return { type, payload, streamId, sequence };
    },
  };
}

function presence(event: RealtimeEvent): { key: string; online: boolean } | null {
  if (event.type !== "agent" || !event.payload || typeof event.payload !== "object") return null;
  const value = event.payload as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id || typeof value.online !== "boolean") return null;
  if (value.projectId != null && typeof value.projectId !== "string") return null;
  return { key: JSON.stringify([value.projectId ?? null, value.id]), online: value.online };
}

/**
 * Coalesce replaceable same-agent updates only. Transitions and durable events
 * flush earlier work. Pending storage is bounded by distinct project/agent keys;
 * this does not impose a bound on total traffic, roster size or DOM nodes.
 */
export function createPresenceBuffer(
  emit: (event: RealtimeEvent) => void,
  defer: Defer,
  capacity = 256,
) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Invalid presence capacity");
  const pending = new Map<string, RealtimeEvent>();
  let cancel: (() => void) | null = null;
  let generation = 0;
  let disposed = false;

  const unschedule = () => {
    generation += 1;
    const previous = cancel;
    cancel = null;
    previous?.();
  };
  const clear = () => {
    unschedule();
    pending.clear();
  };
  const flush = () => {
    unschedule();
    const events = [...pending.values()];
    pending.clear();
    for (const event of events) {
      if (disposed) break;
      emit(event);
    }
  };
  const push = (event: RealtimeEvent) => {
    if (disposed) return;
    // A snapshot boundary must never be followed by buffered pre-boundary agents.
    if (event.type === "hello" || event.type === "project") {
      clear();
      emit(event);
      return;
    }
    const next = presence(event);
    if (!next) {
      flush();
      if (!disposed) emit(event);
      return;
    }
    const previous = pending.get(next.key);
    if (previous && presence(previous)!.online !== next.online) {
      flush();
      if (!disposed) emit(event);
      return;
    }
    if (!previous && pending.size >= capacity) flush();
    if (disposed) return;
    // Preserve arrival order of the retained updates across independent agents.
    pending.delete(next.key);
    pending.set(next.key, event);
    if (!cancel) {
      const scheduledGeneration = ++generation;
      cancel = defer(() => {
        if (!disposed && generation === scheduledGeneration) flush();
      });
    }
  };
  return {
    push,
    clear,
    flush,
    size: () => pending.size,
    dispose: () => {
      disposed = true;
      clear();
    },
  };
}

export type SocketCallbacks = {
  opened: () => void;
  message: (data: unknown) => void;
  closed: () => void;
};

export type RealtimeTransport = {
  /** Install callbacks and return a function that detaches them and closes the socket. */
  open: (callbacks: SocketCallbacks) => () => void;
  deferPresence: Defer;
  retry: Defer;
};

/** Socket lifecycle and event ordering, deliberately independent of HTTP resync. */
export function connectRealtime(
  onEvent: (event: RealtimeEvent) => void,
  onLive: ((live: boolean) => void) | undefined,
  transport: RealtimeTransport,
): () => void {
  let stopped = false;
  let generation = 0;
  let cancelRetry: (() => void) | null = null;
  let closeSocket: (() => void) | null = null;
  let dropPresence: (() => void) | null = null;

  const connect = () => {
    if (stopped) return;
    cancelRetry = null;
    const connectionGeneration = ++generation;
    let alive = true;
    let greeted = false;
    let streamId: string | undefined;
    let sequence = -1;
    const current = () => !stopped && alive && generation === connectionGeneration;
    const buffer = createPresenceBuffer(onEvent, transport.deferPresence);
    dropPresence = buffer.dispose;

    const closed = () => {
      if (!current()) return;
      alive = false;
      buffer.dispose();
      const previous = closeSocket;
      closeSocket = null;
      previous?.();
      onLive?.(false);
      if (!stopped && generation === connectionGeneration) cancelRetry = transport.retry(connect);
    };
    const message = (data: unknown) => {
      if (!current() || typeof data !== "string") return;
      let event: RealtimeEvent;
      try {
        const parsed: unknown = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        if (typeof (parsed as Record<string, unknown>).type !== "string") return;
        event = parsed as RealtimeEvent;
      } catch {
        return;
      }
      const enveloped = event.streamId !== undefined || event.sequence !== undefined;
      if (enveloped && (
        typeof event.streamId !== "string" || !event.streamId ||
        !Number.isSafeInteger(event.sequence) || event.sequence! < 0
      )) return;
      if (event.type === "hello") {
        if (greeted) return;
        greeted = true;
        streamId = event.streamId;
        sequence = event.sequence ?? -1;
      } else if (streamId !== undefined) {
        if (event.streamId !== streamId || event.sequence! <= sequence) return;
        sequence = event.sequence!;
      } else if (enveloped) {
        // Sequenced events need a hello from this connection's server instance.
        return;
      }
      buffer.push(event);
    };
    try {
      const close = transport.open({
        opened: () => { if (current()) onLive?.(true); },
        message,
        closed,
      });
      if (current()) closeSocket = close;
      else close();
    } catch {
      closed();
    }
  };
  connect();
  return () => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    cancelRetry?.();
    cancelRetry = null;
    dropPresence?.();
    dropPresence = null;
    const previous = closeSocket;
    closeSocket = null;
    previous?.();
  };
}
