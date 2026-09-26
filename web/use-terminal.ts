import { useSyncExternalStore } from "react";
import type { Agent } from "../src/shared/types.ts";
import { terminalSessionName } from "../src/shared/terminal-session.ts";
import {
  BROKER_UNAVAILABLE_HINT, SERVER_UNVERIFIED_HINT, TERMINAL_EVENT, TMUX_INSTALL_HINT, decodeTerminalData, encodeTerminalInput, inNativeApp,
  parseTerminalEvent, postNative, terminalDataLength, terminalSessionLaunchProblem, terminalSize,
  type TerminalEvent, type TerminalMessage, type TerminalSessionInfo, type TerminalSessionLaunch,
} from "./native-bridge.ts";

// The page side of Hivemind.app's terminals (docs/terminal-broker.md#bridge):
// one hub per page holds the session list and the broker's status, matches
// answers to requests by id and routes each stream's output to its viewer. In
// a browser there is no hub, and every hook here reports "not native".

type Status = Extract<TerminalEvent, { type: "terminal-status" }>;
export type TerminalLaunched = Extract<TerminalEvent, { type: "terminal-launched" }>;

export type TerminalState = {
  /** False in a browser: no terminal UI at all. */
  native: boolean;
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
  /** Detached, the session ended or the broker went away; the attachment is over. */
  exit: (status: number | null) => void;
  /** The attach was refused (no-such-session, too-many-streams, …); the attachment is over. */
  error: (error: TerminalRequestError) => void;
  attached?: (stream: number) => void;
};

/** One viewer's stream: input and resizes before the broker answers are held (only the latest size) or dropped (keys). */
export type TerminalAttachment = {
  readonly stream: number | null;
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
};

const BROWSER_STATE: TerminalState = { native: false, tmux: null, broker: null, sessions: null, lastError: null };
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
  let state: TerminalState = { native: true, tmux: null, broker: null, sessions: null, lastError: null };
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

  const endStream = (entry: StreamEntry, status: number | null) => {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.timer !== null) win.clearTimeout(entry.timer);
    if (entry.stream !== null) streams.delete(entry.stream);
    entry.handlers.exit(status);
  };
  const failStream = (entry: StreamEntry, error: TerminalRequestError) => {
    if (entry.closed) return;
    entry.closed = true;
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

  /** The broker's streams live on the app's connection; when it drops, every stream and request is over. */
  const brokerLost = () => {
    for (const entry of streams.values()) endStream(entry, null);
    for (const [id, request] of pending) {
      pending.delete(id);
      if (request.kind === "attach") failStream(request.stream, new TerminalRequestError("no-answer", BROKER_UNAVAILABLE_HINT));
      else { win.clearTimeout(request.timer); request.reject(new TerminalRequestError("no-answer", BROKER_UNAVAILABLE_HINT)); }
    }
  };

  const onEvent = (event: Event) => {
    const detail = parseTerminalEvent((event as CustomEvent).detail);
    if (!detail) return;
    switch (detail.type) {
      case "terminal-status": {
        const lost = state.broker === "connected" && detail.broker !== "connected";
        setState({ tmux: detail.tmux, broker: detail.broker, ...(detail.broker === "connected" ? {} : { sessions: null }) });
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
        // Attach carried the size of its time; a resize since then goes now.
        sendSize(entry);
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
        const entry = streams.get(detail.stream);
        if (entry) endStream(entry, detail.status);
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
        if (entry && detail.code === "no-such-stream") endStream(entry, null);
        if (!entry) setState({ lastError: { code: detail.code, message: detail.message } });
        return;
      }
    }
  };
  win.addEventListener(TERMINAL_EVENT, onEvent);

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
    /** Starts (or reuses) one session per launch; resolves with the session names, rejects when refused or unanswered. */
    launch(launches: readonly TerminalSessionLaunch[], openInTerminal: boolean): Promise<TerminalLaunched> {
      const problem = terminalSessionLaunchProblem(launches);
      if (problem) return Promise.reject(new TerminalRequestError("bad-message", problem));
      const id = newId();
      return request<TerminalLaunched>("launch", {
        type: "terminal-launch", id, openInTerminal,
        launches: launches.map(({ project, agent, title, cwd, command, session }) =>
          ({ project, agent, title, ...(cwd ? { cwd } : {}), command, ...(session ? { session } : {}) })),
      });
    },
    /** Opens Terminal.app attached to a running session; false when the page could not ask. */
    open(session: string) {
      return terminalSessionName(session) !== null && post({ type: "terminal-open", session });
    },
    kill(session: string): Promise<void> {
      if (!terminalSessionName(session)) return Promise.reject(new TerminalRequestError("bad-message", "Not a Hivemind session"));
      return request<void>("kill", { type: "terminal-kill", id: newId(), session });
    },
    attach(session: string, cols: number, rows: number, handlers: TerminalStreamHandlers): TerminalAttachment {
      const entry: StreamEntry = { handlers, stream: null, closed: false, size: terminalSize(cols, rows), sent: null, timer: null };
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
          if (entry.closed || entry.stream === null) return false;
          for (const chunk of encodeTerminalInput(data)) post({ type: "terminal-input", stream: entry.stream, data: chunk });
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
          if (entry.timer !== null) { win.clearTimeout(entry.timer); entry.timer = null; }
          if (stream !== null) { streams.delete(stream); post({ type: "terminal-detach", stream }); }
        },
      };
    },
    dispose() {
      win.removeEventListener(TERMINAL_EVENT, onEvent);
      if (releaseTimer !== null) win.clearTimeout(releaseTimer);
      for (const request of pending.values()) {
        if (request.kind !== "attach") win.clearTimeout(request.timer);
        else if (request.stream.timer !== null) win.clearTimeout(request.stream.timer);
      }
      pending.clear();
      listeners.clear();
    },
  };
}

let shared: TerminalHub | null = null;

/** The page's hub, created on first use inside Hivemind.app; null in a browser. */
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

export type TerminalBlocker = { kind: "server" | "unverified" | "tmux" | "connecting"; message: string };

/** Why terminals cannot be used right now, or null when they can. */
export function terminalBlocker(state: TerminalState): TerminalBlocker | null {
  if (!state.native) return null;
  if (state.broker === "unverified") return { kind: "unverified", message: SERVER_UNVERIFIED_HINT };
  if (state.broker === "unavailable") return { kind: "server", message: BROKER_UNAVAILABLE_HINT };
  if (state.broker !== "connected") return { kind: "connecting", message: "Connecting to Hivemind Server…" };
  if (state.tmux === "missing") return { kind: "tmux", message: TMUX_INSTALL_HINT };
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
