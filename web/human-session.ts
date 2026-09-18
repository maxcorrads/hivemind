type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

/** One coordinator per tab; the HttpOnly cookie itself is shared by all tabs. */
export function createHumanSession(fetcher: Fetcher = (path, init) => fetch(path, init)) {
  let valid = false;
  let generation = 0;
  let flight: Promise<number> | null = null;

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
    return fetcher(path, options); // At most one replay, even after a second 401.
  }

  return { request, refresh: () => establish(true) };
}

export const humanSession = createHumanSession();

type HumanEvent = { type: string; payload: unknown };

/** Refresh before every handshake: WebSocket does not expose a failed HTTP status. */
export function connectHumanWs(
  session: Pick<ReturnType<typeof createHumanSession>, "refresh">,
  onEvent: (event: HumanEvent) => void,
  onLive?: (live: boolean) => void,
  makeSocket: () => WebSocket = () => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    return new WebSocket(`${protocol}://${location.host}/ws`);
  },
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (closed) return;
    timer = setTimeout(() => { timer = undefined; void connect(); }, 1500);
  };
  const connect = async () => {
    try {
      await session.refresh();
      if (closed) return;
      const current = makeSocket();
      socket = current;
      current.onopen = () => { if (!closed && socket === current) onLive?.(true); };
      current.onmessage = (event) => {
        if (closed || socket !== current) return;
        try { onEvent(JSON.parse(String(event.data))); } catch { /* Ignore invalid events. */ }
      };
      current.onerror = () => { /* Failed browser handshakes also emit close. */ };
      current.onclose = () => {
        if (closed || socket !== current) return;
        socket = null;
        onLive?.(false);
        schedule();
      };
    } catch {
      if (closed) return;
      onLive?.(false);
      schedule();
    }
  };
  void connect();
  return () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
      socket = null;
    }
  };
}
