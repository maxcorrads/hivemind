type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
import { connectRealtime } from "../src/shared/realtime-client.ts";
import { inNativeApp, postNative } from "./native-bridge.ts";

/**
 * The remote gateway's mark on a 401 that is about the device session, not the Human one: Hivemind Server.app on the
 * Mac forgot it (it restarted) or it expired. Only the iPhone/iPad app holds the device token, so the page asks it to
 * renew (docs/remote-access.md#device-sessions); the page's own retries then go through with the new cookie.
 */
export const DEVICE_SESSION_HEADER = "x-hivemind-device-session";
/** At most one device-session-expired per this many ms per page. */
export const DEVICE_SESSION_NOTICE_INTERVAL = 2_000;

export type DeviceSessionNotifier = {
  /** Whether the page runs in an app that can renew the device session. */
  native: () => boolean;
  /** Tells the app; false when it could not. */
  post: () => boolean;
  now: () => number;
};

const liveNotifier: DeviceSessionNotifier = {
  native: () => inNativeApp(),
  post: () => postNative({ type: "device-session-expired" }),
  now: () => Date.now(),
};

/** One coordinator per tab; the HttpOnly cookie itself is shared by all tabs. */
export function createHumanSession(fetcher: Fetcher = (path, init) => fetch(path, init), device: DeviceSessionNotifier = liveNotifier) {
  let valid = false;
  let generation = 0;
  let flight: Promise<number> | null = null;
  let noticedAt: number | null = null;

  /** A gateway 401 for the device session: ask the app to renew it, throttled. */
  function checkDeviceSession(response: Response) {
    if (response.status !== 401 || response.headers.get(DEVICE_SESSION_HEADER) !== "required" || !device.native()) return;
    const now = device.now();
    if (noticedAt !== null && now - noticedAt < DEVICE_SESSION_NOTICE_INTERVAL) return;
    if (device.post()) noticedAt = now;
  }

  async function establish(force = false, rejectedGeneration?: number): Promise<number> {
    if (flight) return flight;
    if (force || rejectedGeneration === generation) valid = false;
    if (valid) return generation;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10_000);
    const pending = (async () => {
      const response = await fetcher("/api/ui/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hivemind-ui": "1" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      await response.body?.cancel();
      checkDeviceSession(response);
      if (!response.ok) throw new Error(`Human session bootstrap failed (HTTP ${response.status})`);
      valid = true;
      return ++generation;
    })();
    flight = pending;
    try {
      return await pending;
    } finally {
      clearTimeout(deadline);
      if (flight === pending) flight = null;
    }
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    init.signal?.throwIfAborted();
    const observedGeneration = await establish();
    init.signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set("x-hivemind-ui", "1");
    const options: RequestInit = { ...init, headers, credentials: "same-origin", redirect: "error" };
    const response = await fetcher(path, options);
    checkDeviceSession(response);
    if (response.status !== 401 || response.headers.get("x-hivemind-session-required") !== "1") return response;

    // A network exception or a generic handler 401 NEVER reaches this branch.
    // The server marker guarantees rejection before any mutation ran.
    try {
      await establish(false, observedGeneration);
      init.signal?.throwIfAborted();
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (init.body instanceof ReadableStream) return response; // Non-replayable body.
    await response.body?.cancel();
    const replay = await fetcher(path, options); // At most one replay, even after a second 401.
    checkDeviceSession(replay);
    return replay;
  }

  return { request, refresh: () => establish(true) };
}

export const humanSession = createHumanSession();

type HumanEvent = { type: string; payload: unknown };

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential from 1s up to 30s,
 * with jitter over the upper half so many tabs do not reconnect in lockstep.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(attempt, 0), 5));
  return Math.round(ceiling / 2 + random() * ceiling / 2);
}

/** Refresh before every handshake: WebSocket does not expose a failed HTTP status. */
export function connectHumanWs(
  session: Pick<ReturnType<typeof createHumanSession>, "refresh">,
  onEvent: (event: HumanEvent) => void,
  onLive?: (live: boolean) => void,
  makeSocket: () => WebSocket = () => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    return new WebSocket(`${protocol}://${location.host}/ws`);
  },
  delay: (attempt: number) => number = reconnectDelay,
): () => void {
  const later = (ms: number) => (run: () => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  };
  // Consecutive failed connections; an opened socket resets the backoff.
  let failures = 0;
  return connectRealtime(onEvent, onLive, {
    open: (callbacks) => {
      let stopped = false;
      let socket: WebSocket | null = null;
      void session.refresh().then(() => {
        if (stopped) return;
        const current = makeSocket();
        socket = current;
        current.onopen = () => {
          if (stopped || socket !== current) return;
          failures = 0;
          callbacks.opened();
        };
        current.onmessage = (event) => { if (!stopped && socket === current) callbacks.message(event.data); };
        current.onerror = () => { /* Failed browser handshakes also emit close. */ };
        current.onclose = () => {
          if (stopped || socket !== current) return;
          socket = null;
          callbacks.closed();
        };
      }).catch(() => { if (!stopped) callbacks.closed(); });
      return () => {
        stopped = true;
        if (!socket) return;
        const current = socket;
        socket = null;
        current.onopen = current.onmessage = current.onclose = null;
        current.close();
      };
    },
    deferPresence: later(16),
    retry: (run) => later(delay(failures++))(run),
  });
}
