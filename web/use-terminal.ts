import { useSyncExternalStore } from "react";
import type { Agent } from "../src/shared/types.ts";
import { terminalSessionName } from "../src/shared/terminal-session.ts";
import {
  TERMINAL_EVENT, brokerUnavailableHint, decodeTerminalData, encodeTerminalInput, inNativeApp, onMacDesktop, onNativePlatform,
  parseTerminalEvent, postNative, reportedNativePlatform, serverUnverifiedHint, terminalDataLength, terminalSessionLaunchProblem, terminalSize,
  tmuxInstallHint, type NativePlatform, type TerminalEvent, type TerminalMessage, type TerminalSessionInfo, type TerminalSessionLaunch,
} from "./native-bridge.ts";

// The page side of the apps' terminals (docs/terminal-broker.md#bridge):
// one hub per page holds the session list and the broker's status, matches
// answers to requests by id and routes each stream's output to its viewer. In
// a browser there is no hub, and every hook here reports "not native".

type Status = Extract<TerminalEvent, { type: "terminal-status" }>;
export type TerminalLaunched = Extract<TerminalEvent, { type: "terminal-launched" }>;

export type TerminalState = {
  /** False in a browser: no terminal UI at all. */
  native: boolean;
  /**
   * Which app hosts the page: null in a browser. "macos" until the app says otherwise, as Hivemind.app on the Mac,
   * which predates the field, never does; the iOS app says "ios" in its answer to ready and in every terminal-status.
   */
  platform: NativePlatform | null;
  /** Null until the app reports them. */
  tmux: Status["tmux"] | null;
  broker: Status["broker"] | null;
  /** Every Hivemind session, sorted by name; null while unknown (no broker). */
  sessions: TerminalSessionInfo[] | null;
  /** The latest error that answered no request of this page, e.g. Open in Terminal on a session that just ended. */
  lastError: { code: string; message: string } | null;
};

/** A refused request: `code` is the broker's (BrokerErrorCode), or "no-answer" / "not-sent" from the page. */
export class TerminalRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TerminalRequestError";
  }
}

export type TerminalStreamHandlers = {
  /**
   * Raw bytes for xterm's write(). Call `drawn` once they are drawn (xterm's write callback): the hub acks them to
   * the app, which stops reading the broker while too much output is not acked (docs/terminal-broker.md).
   */
  output: (data: Uint8Array, drawn: () => void) => void;
  /**
   * The attach client exited with `status` (the session ended or was killed, or it was detached with tmux's own key),
   * or, with null, the stream ended without a status; the attachment is over.
   */
  exit: (status: number | null) => void;
  /**
   * The stream was lost, not ended: the app's connection to the broker dropped (a restart, a network blip, a session
   * that expired) or the broker forgot the stream, while the tmux session may well still run. The attachment is over;
   * attach again to the same session once the broker is connected and lists it as alive (TerminalView does). Without
   * this handler a lost stream is reported as exit(null).
   */
  lost?: () => void;
  /** The attach was refused (no-such-session, too-many-streams, …); the attachment is over. */
  error: (error: TerminalRequestError) => void;
  attached?: (stream: number) => void;
};

/**
 * One viewer's stream. Before the broker answers the attach, resizes are held (only the latest size) and keys are held
 * in order (at most HELD_INPUT_BYTES, the oldest dropped beyond): both go once the stream is attached, and held keys are
 * discarded if the attach fails or the viewer detaches first.
 */
export type TerminalAttachment = {
  readonly stream: number | null;
  /** Sends `data`, or holds it until the stream is attached; false once the attachment is over (nothing is sent). */
  input: (data: string | Uint8Array) => boolean;
  resize: (cols: number, rows: number) => void;
  detach: () => void;
};

type Win = Window & typeof globalThis;
type Pending =
  | { kind: "launch"; resolve: (event: TerminalLaunched) => void; reject: (error: TerminalRequestError) => void; timer: number }
  | { kind: "kill"; resolve: () => void; reject: (error: TerminalRequestError) => void; timer: number }
  | { kind: "attach"; stream: StreamEntry };
type StreamEntry = {
  handlers: TerminalStreamHandlers;
  stream: number | null;
  closed: boolean;
  size: { cols: number; rows: number };
  sent: { cols: number; rows: number } | null;
  timer: number | null;
  /** Keys typed before the stream is attached, oldest first; `heldBytes` is their total. */
  held: Uint8Array[];
  heldBytes: number;
};

/** How much input typed before the stream is attached is kept for it (64 KiB); older keys beyond are dropped. */
export const HELD_INPUT_BYTES = 64 * 1024;

const BROWSER_STATE: TerminalState = { native: false, platform: null, tmux: null, broker: null, sessions: null, lastError: null };
const NO_ANSWER = "Hivemind did not answer. Is Hivemind Server running?";

export type TerminalHub = ReturnType<typeof createTerminalHub>;

/**
 * The hub for `win`'s bridge. `timeouts.request` bounds how long a launch, kill or attach waits for its
 * answer (the app answers a throttled one with an error, but drops a malformed one silently); `timeouts.linger` keeps the
 * sessions subscription a moment after the last viewer leaves, so remounts do not churn it.
 */
export function createTerminalHub(win: Win, timeouts: { request?: number; attach?: number; linger?: number } = {}) {
  const requestTimeout = timeouts.request ?? 15_000;
  const attachTimeout = timeouts.attach ?? 10_000;
  const linger = timeouts.linger ?? 1_000;
  let state: TerminalState = {
    native: true, platform: reportedNativePlatform() ?? "macos", tmux: null, broker: null, sessions: null, lastError: null,
  };
  const listeners = new Set<() => void>();
  const pending = new Map<string, Pending>();
  const streams = new Map<number, StreamEntry>();
  let nextId = 0;
  let subscribed = false;
  let releaseTimer: number | null = null;

  const post = (message: TerminalMessage) => postNative(message, win);
  const emit = () => { for (const listener of listeners) listener(); };
  const setState = (patch: Partial<TerminalState>) => { state = { ...state, ...patch }; emit(); };
  const newId = () => `p${++nextId}`;

  const dropHeld = (entry: StreamEntry) => { entry.held = []; entry.heldBytes = 0; };
  /** Keeps `data` for the stream being attached: whole chunks, oldest dropped past HELD_INPUT_BYTES (a larger one keeps its end). */
  const hold = (entry: StreamEntry, data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data.slice();
    if (bytes.length === 0) return;
    entry.held.push(bytes.length > HELD_INPUT_BYTES ? bytes.slice(bytes.length - HELD_INPUT_BYTES) : bytes);
    entry.heldBytes += Math.min(bytes.length, HELD_INPUT_BYTES);
    while (entry.heldBytes > HELD_INPUT_BYTES) entry.heldBytes -= entry.held.shift()!.length;
  };
  const sendInput = (entry: StreamEntry, data: string | Uint8Array) => {
    for (const chunk of encodeTerminalInput(data)) post({ type: "terminal-input", stream: entry.stream!, data: chunk });
  };
  const endStream = (entry: StreamEntry, status: number | null) => {
    if (entry.closed) return;
    entry.closed = true;
    dropHeld(entry);
    if (entry.timer !== null) win.clearTimeout(entry.timer);
    if (entry.stream !== null) streams.delete(entry.stream);
    entry.handlers.exit(status);
  };
  /** Over without the viewer asking and without an exit status: the session may still run (TerminalStreamHandlers.lost). */
  const loseStream = (entry: StreamEntry) => {
    if (entry.closed) return;
    entry.closed = true;
    dropHeld(entry);
    if (entry.timer !== null) win.clearTimeout(entry.timer);
    if (entry.stream !== null) streams.delete(entry.stream);
    if (entry.handlers.lost) entry.handlers.lost(); else entry.handlers.exit(null);
  };
  const failStream = (entry: StreamEntry, error: TerminalRequestError) => {
    if (entry.closed) return;
    entry.closed = true;
    dropHeld(entry);
    if (entry.timer !== null) win.clearTimeout(entry.timer);
    if (entry.stream !== null) streams.delete(entry.stream);
    entry.handlers.error(error);
  };
  const sendSize = (entry: StreamEntry) => {
    if (entry.stream === null || entry.closed) return;
    if (entry.sent && entry.sent.cols === entry.size.cols && entry.sent.rows === entry.size.rows) return;
    entry.sent = entry.size;
    post({ type: "terminal-resize", stream: entry.stream, ...entry.size });
  };

  /**
   * The broker's streams live on the app's connection; when it drops, every stream and request is over. Streams and
   * attaches still waiting are lost, not ended: their viewers attach again once the broker is back.
   */
  const brokerLost = () => {
    const hint = brokerUnavailableHint(state.platform);
    for (const entry of streams.values()) loseStream(entry);
    for (const [id, request] of pending) {
      pending.delete(id);
      if (request.kind === "attach") loseStream(request.stream);
      else { win.clearTimeout(request.timer); request.reject(new TerminalRequestError("no-answer", hint)); }
    }
  };

  const onEvent = (event: Event) => {
    const detail = parseTerminalEvent((event as CustomEvent).detail);
    if (!detail) return;
    switch (detail.type) {
      case "terminal-status": {
        const lost = state.broker === "connected" && detail.broker !== "connected";
        setState({ platform: detail.platform, tmux: detail.tmux, broker: detail.broker,
          ...(detail.broker === "connected" ? {} : { sessions: null }) });
        if (lost) brokerLost();
        return;
      }
      case "sessions":
        setState({ sessions: detail.items });
        return;
      case "terminal-launched": {
        const request = detail.id ? pending.get(detail.id) : undefined;
        if (request?.kind !== "launch") return;
        pending.delete(detail.id!);
        win.clearTimeout(request.timer);
        request.resolve(detail);
        return;
      }
      case "terminal-killed": {
        if (state.sessions?.some(item => item.name === detail.session)) {
          setState({ sessions: state.sessions.filter(item => item.name !== detail.session) });
        }
        const request = detail.id ? pending.get(detail.id) : undefined;
        if (request?.kind !== "kill") return;
        pending.delete(detail.id!);
        win.clearTimeout(request.timer);
        request.resolve();
        return;
      }
      case "terminal-attached": {
        const request = detail.id ? pending.get(detail.id) : undefined;
        if (request?.kind !== "attach") return;
        pending.delete(detail.id!);
        const entry = request.stream;
        // The viewer left (or gave up) before the answer: the stream is not wanted.
        if (entry.closed) { post({ type: "terminal-detach", stream: detail.stream }); return; }
        if (entry.timer !== null) { win.clearTimeout(entry.timer); entry.timer = null; }
        entry.stream = detail.stream;
        streams.set(detail.stream, entry);
        entry.handlers.attached?.(detail.stream);
        // Attach carried the size of its time; a resize since then goes now, then the keys typed meanwhile, in order.
        sendSize(entry);
        const held = entry.held;
        dropHeld(entry);
        for (const bytes of held) {
          if (entry.closed) break;
          sendInput(entry, bytes);
        }
        return;
      }
      case "terminal-output": {
        const entry = streams.get(detail.stream);
        if (!entry) return;
        const stream = detail.stream;
        const bytes = terminalDataLength(detail.data);
        let acked = false;
        entry.handlers.output(decodeTerminalData(detail.data), () => {
          // Once, and only while the stream is still this viewer's: the app forgets a detached stream's output.
          if (acked || entry.closed || entry.stream !== stream || bytes === 0) return;
          acked = true;
          post({ type: "terminal-ack", stream, bytes });
        });
        return;
      }
      case "terminal-exit": {
        // A stream the viewer detached is no longer listed, so an exit without a status here was not asked for: the
        // app's connection to the broker went (it ends every stream so) or the broker detached it. The session may run.
        const entry = streams.get(detail.stream);
        if (entry && detail.status === null) loseStream(entry);
        else if (entry) endStream(entry, detail.status);
        return;
      }
      case "terminal-error": {
        const error = new TerminalRequestError(detail.code, detail.message);
        const request = detail.id ? pending.get(detail.id) : undefined;
        if (request) {
          pending.delete(detail.id!);
          if (request.kind === "attach") failStream(request.stream, error);
          else { win.clearTimeout(request.timer); request.reject(error); }
          return;
        }
        // A stream the broker no longer knows is over; other stream errors (a refused input) are not.
        const entry = detail.stream !== null ? streams.get(detail.stream) : undefined;
        if (entry && detail.code === "no-such-stream") loseStream(entry);
        if (!entry) setState({ lastError: { code: detail.code, message: detail.message } });
        return;
      }
    }
  };
  win.addEventListener(TERMINAL_EVENT, onEvent);
  const offPlatform = onNativePlatform(platform => { if (platform !== state.platform) setState({ platform }); });

  const retain = () => {
    if (releaseTimer !== null) { win.clearTimeout(releaseTimer); releaseTimer = null; }
    if (!subscribed) subscribed = post({ type: "sessions-subscribe" });
  };
  const release = () => {
    if (releaseTimer !== null) win.clearTimeout(releaseTimer);
    releaseTimer = win.setTimeout(() => {
      releaseTimer = null;
      if (listeners.size === 0 && subscribed) { post({ type: "sessions-unsubscribe" }); subscribed = false; }
    }, linger);
  };

  function request<T>(kind: "launch" | "kill", message: TerminalMessage & { id?: string }) {
    return new Promise<T>((resolve, reject) => {
      const id = message.id!;
      if (!post(message)) { reject(new TerminalRequestError("not-sent", "Terminals are available only in Hivemind.app")); return; }
      const timer = win.setTimeout(() => {
        pending.delete(id);
        reject(new TerminalRequestError("no-answer", NO_ANSWER));
      }, requestTimeout);
      pending.set(id, { kind, resolve, reject, timer } as Pending);
    });
  }

  return {
    get state() { return state; },
    /** For useSyncExternalStore: the first listener subscribes to the session list, the last one unsubscribes. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      retain();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) release();
      };
    },
    /**
     * Starts (or reuses) one session per launch; resolves with the session names, rejects when refused or unanswered.
     * `openInTerminal` asks for Terminal.app windows, which only the Mac has: off it, the launch goes without them.
     */
    launch(launches: readonly TerminalSessionLaunch[], openInTerminal: boolean): Promise<TerminalLaunched> {
      const problem = terminalSessionLaunchProblem(launches);
      if (problem) return Promise.reject(new TerminalRequestError("bad-message", problem));
      const id = newId();
      return request<TerminalLaunched>("launch", {
        type: "terminal-launch", id, openInTerminal: openInTerminal && onMacDesktop(state.platform),
        launches: launches.map(({ project, agent, title, cwd, command, session }) =>
          ({ project, agent, title, ...(cwd ? { cwd } : {}), command, ...(session ? { session } : {}) })),
      });
    },
    /** Opens Terminal.app attached to a running session; false when the page could not ask, or off the Mac. */
    open(session: string) {
      return onMacDesktop(state.platform) && terminalSessionName(session) !== null && post({ type: "terminal-open", session });
    },
    kill(session: string): Promise<void> {
      if (!terminalSessionName(session)) return Promise.reject(new TerminalRequestError("bad-message", "Not a Hivemind session"));
      return request<void>("kill", { type: "terminal-kill", id: newId(), session });
    },
    attach(session: string, cols: number, rows: number, handlers: TerminalStreamHandlers): TerminalAttachment {
      const entry: StreamEntry = {
        handlers, stream: null, closed: false, size: terminalSize(cols, rows), sent: null, timer: null, held: [], heldBytes: 0,
      };
      const id = newId();
      const fail = (code: string, message: string) => {
        // Reported after attach() returns, as an answer would be.
        queueMicrotask(() => failStream(entry, new TerminalRequestError(code, message)));
      };
      if (!terminalSessionName(session)) fail("bad-message", "Not a Hivemind session");
      else if (!post({ type: "terminal-attach", id, session, ...entry.size })) fail("not-sent", "Terminals are available only in Hivemind.app");
      else {
        entry.sent = entry.size;
        pending.set(id, { kind: "attach", stream: entry });
        entry.timer = win.setTimeout(() => { entry.timer = null; failStream(entry, new TerminalRequestError("no-answer", NO_ANSWER)); }, attachTimeout);
      }
      return {
        get stream() { return entry.closed ? null : entry.stream; },
        input(data) {
          if (entry.closed) return false;
          if (entry.stream === null) hold(entry, data);
          else sendInput(entry, data);
          return true;
        },
        resize(nextCols, nextRows) {
          entry.size = terminalSize(nextCols, nextRows);
          sendSize(entry);
        },
        detach() {
          if (entry.closed) return;
          const stream = entry.stream;
          entry.closed = true;
          dropHeld(entry);
          if (entry.timer !== null) { win.clearTimeout(entry.timer); entry.timer = null; }
          if (stream !== null) { streams.delete(stream); post({ type: "terminal-detach", stream }); }
        },
      };
    },
    dispose() {
      win.removeEventListener(TERMINAL_EVENT, onEvent);
      offPlatform();
      if (releaseTimer !== null) win.clearTimeout(releaseTimer);
      for (const request of pending.values()) {
        if (request.kind !== "attach") win.clearTimeout(request.timer);
        else {
          if (request.stream.timer !== null) win.clearTimeout(request.stream.timer);
          dropHeld(request.stream);
        }
      }
      pending.clear();
      listeners.clear();
    },
  };
}

let shared: TerminalHub | null = null;

/** The page's hub, created on first use inside either app; null in a browser. */
export function terminalHub(): TerminalHub | null {
  if (!shared && typeof window !== "undefined" && inNativeApp(window)) shared = createTerminalHub(window);
  return shared;
}

/** Tests only: forget the page's hub (the next terminalHub() makes a new one). */
export function resetTerminalHub() {
  shared?.dispose();
  shared = null;
}

const noop = () => () => {};
const browserState = () => BROWSER_STATE;

/** Terminal status and sessions, kept current while mounted; `native` false (and nothing sent) in a browser. */
export function useTerminalState(): TerminalState {
  const hub = terminalHub();
  return useSyncExternalStore(hub ? hub.subscribe : noop, hub ? () => hub.state : browserState, browserState);
}

/** The session an agent reported on join, when it is a Hivemind session name. */
export function agentTerminalSession(agent: Agent | undefined | null): string | null {
  return terminalSessionName((agent as { terminalSession?: unknown } | null | undefined)?.terminalSession);
}

/** The running session of that name, if the broker lists it. */
export function liveSession(state: TerminalState, name: string | null): TerminalSessionInfo | null {
  if (!name || !state.sessions) return null;
  return state.sessions.find(item => item.name === name && item.alive) ?? null;
}

export type TerminalBlocker = {
  kind: "server" | "unverified" | "tmux" | "connecting";
  message: string;
  /** Offer Start Hivemind Server: only Hivemind.app on the Mac can start it; a device cannot. */
  canStart?: boolean;
};

/** Why terminals cannot be used right now, or null when they can. */
export function terminalBlocker(state: TerminalState): TerminalBlocker | null {
  if (!state.native) return null;
  if (state.broker === "unverified") return { kind: "unverified", message: serverUnverifiedHint(state.platform) };
  if (state.broker === "unavailable") {
    return { kind: "server", message: brokerUnavailableHint(state.platform), canStart: onMacDesktop(state.platform) };
  }
  if (state.broker !== "connected") return { kind: "connecting", message: "Connecting to Hivemind Server…" };
  if (state.tmux === "missing") return { kind: "tmux", message: tmuxInstallHint(state.platform) };
  if (state.tmux !== "available") return { kind: "connecting", message: "Looking for tmux…" };
  return null;
}

// ---- Look ----------------------------------------------------------------------------------------------------------

/** ANSI colors readable on --surface; the rest of the theme comes from the design tokens. */
const ANSI = {
  light: {
    black: "#16171b", red: "#c4312f", green: "#1f7a45", yellow: "#8a6100", blue: "#2957c4", magenta: "#8b3fb8", cyan: "#0f7580",
    white: "#676a73", brightBlack: "#8b8e97", brightRed: "#d9453f", brightGreen: "#2a9357", brightYellow: "#a37500",
    brightBlue: "#3a6ee0", brightMagenta: "#a052d0", brightCyan: "#16909c", brightWhite: "#3b3d44",
  },
  dark: {
    black: "#3b3d44", red: "#ef6b6b", green: "#5fc88f", yellow: "#e0b25c", blue: "#6ea8ff", magenta: "#c58af9", cyan: "#4fc4cf",
    white: "#c2c4ca", brightBlack: "#676a73", brightRed: "#ff8a8a", brightGreen: "#7ee2a8", brightYellow: "#f2cc7a",
    brightBlue: "#93bfff", brightMagenta: "#d8a8ff", brightCyan: "#7adbe3", brightWhite: "#ececef",
  },
} as const;

/**
 * A token's color as rgb()/rgba(), which xterm parses (it does not read oklch). Drawn on a 1×1 canvas;
 * where there is no canvas the value is returned unchanged.
 */
export function rgbColor(value: string, alpha = 1, doc: Document = document): string {
  try {
    const canvas = doc.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return value;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    const opacity = Math.round((a! / 255) * alpha * 1000) / 1000;
    return opacity >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${opacity})`;
  } catch {
    return value;
  }
}

export const isDarkTheme = (doc: Document = document) => doc.documentElement.classList.contains("dark");

/** xterm's theme for the current light/dark tokens (html.dark, web/use-theme.ts). */
export function terminalTheme(doc: Document = document) {
  const style = doc.defaultView?.getComputedStyle(doc.documentElement);
  const token = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback;
  const dark = isDarkTheme(doc);
  const background = rgbColor(token("--surface", dark ? "#17181c" : "#ffffff"), 1, doc);
  const foreground = rgbColor(token("--ink", dark ? "#ececef" : "#16171b"), 1, doc);
  return {
    background, foreground, cursor: foreground, cursorAccent: background,
    selectionBackground: rgbColor(token("--accent", "#4b6fd6"), 0.3, doc),
    ...(dark ? ANSI.dark : ANSI.light),
  };
}

/** The terminal font: the UI's mono stack (--mono). */
export function terminalFont(doc: Document = document) {
  return doc.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue("--mono").trim() || "ui-monospace, monospace";
}

// ---- Keys ----------------------------------------------------------------------------------------------------------

/** What a key of the touch row sends. Arrows follow the application cursor mode the program asked for. */
export function touchKey(key: "esc" | "tab" | "ctrl-c" | "up" | "down" | "left" | "right", applicationCursor = false): string {
  const arrow = (code: string) => (applicationCursor ? "\x1bO" : "\x1b[") + code;
  switch (key) {
    case "esc": return "\x1b";
    case "tab": return "\t";
    case "ctrl-c": return "\x03";
    case "up": return arrow("A");
    case "down": return arrow("B");
    case "right": return arrow("C");
    case "left": return arrow("D");
  }
}

/** Typed text with Ctrl held (the touch row's sticky Ctrl): a letter or @[\]^_ becomes its control code; other text is unchanged. */
export function withControl(data: string): string {
  if (data.length !== 1) return data;
  if (data === " ") return "\0";
  if (data === "?") return "\x7f";
  const code = data.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code - 0x40) : data;
}
