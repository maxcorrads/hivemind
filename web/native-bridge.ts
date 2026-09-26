import { useEffect, useRef, useState } from "react";
import { terminalSessionName } from "../src/shared/terminal-session.ts";
import { hashFor, parseHash, type Sel } from "./selection.ts";

// Hivemind.app on the Mac (macos/) and the iPhone/iPad app (ios/) load this UI
// in a WKWebView and register window.webkit.messageHandlers.hivemind; the
// contract is HivemindKit/Bridge.swift. Everything here is inert in a browser:
// no handler, no messages, no listener.

/** The DOM event native commands arrive as: CustomEvent with detail {command, hash?}. */
export const NATIVE_EVENT = "hivemind:native";

type Poster = { postMessage(message: unknown): void };
type BridgeWindow = { webkit?: { messageHandlers?: { hivemind?: Poster } } };

/** The app's message handler, or null in a browser. */
export function nativeBridge(win: unknown = globalThis.window): Poster | null {
  const handler = (win as BridgeWindow | undefined)?.webkit?.messageHandlers?.hivemind;
  return typeof handler?.postMessage === "function" ? handler : null;
}

export const inNativeApp = (win?: unknown) => nativeBridge(win) !== null;

/**
 * Which app hosts the page. "macos" is Hivemind.app on the Mac, which can open Terminal.app and start Hivemind
 * Server; "ios" is the iPhone/iPad app, whose terminals run on the Mac and show only in the page. The iOS app names
 * it in its answer to ready (a "ready" native command) and in every terminal-status; the Mac app predates both.
 */
export type NativePlatform = "macos" | "ios";

/**
 * The platform the app names. Hivemind.app on the Mac predates the field, so an absent one is "macos";
 * any other value is a device that is not the Mac and is offered nothing that runs on the Mac's desktop.
 */
export function nativePlatform(value: unknown): NativePlatform {
  return value === undefined || value === null || value === "macos" ? "macos" : "ios";
}

let reported: NativePlatform | null = null;
const platformListeners = new Set<(platform: NativePlatform) => void>();
const reportPlatform = (platform: NativePlatform) => {
  reported = platform;
  for (const listener of platformListeners) listener(platform);
};

/**
 * The platform the app named in its answer to ready, or null before one (always, from Hivemind.app on the Mac).
 * The terminal hub starts from it, so a sheet opened after the answer never shows the Mac's actions on a device.
 */
export const reportedNativePlatform = () => reported;

/** Calls `listener` with every platform the app reports from now on; returns the unsubscribe. */
export function onNativePlatform(listener: (platform: NativePlatform) => void): () => void {
  platformListeners.add(listener);
  return () => { platformListeners.delete(listener); };
}

/** Tests only: forget the reported platform. */
export function resetNativePlatform() { reported = null; }

/**
 * Which app hosts the page, kept current: null in a browser; inside an app the platform it reported, "macos" until it
 * reports one (Hivemind.app on the Mac never does). Follows a ready answer that arrives after the first render.
 */
export function useNativePlatform(win?: unknown): NativePlatform | null {
  const [platform, setPlatform] = useState<NativePlatform | null>(() => inNativeApp(win) ? reported ?? "macos" : null);
  useEffect(() => {
    if (!inNativeApp(win)) return;
    setPlatform(reported ?? "macos");
    return onNativePlatform(setPlatform);
  }, [win]);
  return platform;
}

/** Asks the iPhone/iPad app to show its list of paired Macs (only it has one); false elsewhere. */
export function switchMac(win?: unknown): boolean {
  return postNative({ type: "switch-mac" }, win);
}

export type NativeMessage =
  | { type: "ready" }
  /** `target` is the hash route the notice opens; the app hands it back as a "navigate" command on click. */
  | { type: "notify"; title: string; body: string; tag: string; target: string }
  | { type: "badge"; count: number }
  /** The iPhone/iPad app only (Settings → Switch Mac…): show the paired Macs to pick another. */
  | { type: "switch-mac" }
  /**
   * The iPhone/iPad app only: the gateway answered 401 with X-Hivemind-Device-Session: required (it forgot or expired
   * the device session). The app renews it with its device token and installs the new cookie; the page just retries.
   */
  | { type: "device-session-expired" }
  | TerminalMessage;

/** Posts to the app; false in a browser or when WebKit refuses the message. */
export function postNative(message: NativeMessage, win?: unknown): boolean {
  const bridge = nativeBridge(win);
  if (!bridge) return false;
  try {
    bridge.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

export function notifyNative(notice: { title: string; body: string; tag: string; target: Sel }, win?: unknown) {
  return postNative({ type: "notify", title: notice.title, body: notice.body, tag: notice.tag,
    target: `#${hashFor(notice.target)}` }, win);
}

/** A badge sender that crosses the bridge only when the count changes, not on every snapshot. */
export function badgeSync(post: (message: NativeMessage) => boolean = message => postNative(message)) {
  let last: number | null = null;
  return (count: number) => {
    if (count === last) return;
    if (post({ type: "badge", count })) last = count;
  };
}

export type NativeCommandHandlers = {
  jump: () => void;
  forYou: () => void;
  newChannel: () => void;
  settings: () => void;
  toggleTheme: () => void;
  navigate: (sel: Sel) => void;
};

/** Runs one native command; false for anything unknown or malformed. */
export function runNativeCommand(detail: unknown, handlers: NativeCommandHandlers): boolean {
  if (!detail || typeof detail !== "object") return false;
  const { command, hash, platform } = detail as { command?: unknown; hash?: unknown; platform?: unknown };
  switch (command) {
    // The iOS app's answer to the page's ready (Hivemind.app on the Mac sends none): which app hosts the page.
    case "ready":
      if (typeof platform !== "string") return false;
      reportPlatform(nativePlatform(platform));
      return true;
    case "jump": handlers.jump(); return true;
    case "for-you": handlers.forYou(); return true;
    case "new-channel": handlers.newChannel(); return true;
    case "settings": handlers.settings(); return true;
    case "toggle-theme": handlers.toggleTheme(); return true;
    case "navigate":
      // Only in-app routes: parseHash reads anything else as #general.
      if (typeof hash !== "string" || !/^#\/\S+$/.test(hash)) return false;
      handlers.navigate(parseHash(hash));
      return true;
    default:
      return false;
  }
}

/**
 * Wires the page to the app: native commands to `handlers`, the attention
 * total to the Dock badge, and "ready" once the page can act on commands.
 * `badge` is null until there is a snapshot, so a reload does not clear the
 * Dock badge on the way.
 */
export function useNativeBridge({ ready, badge, handlers }: {
  ready: boolean; badge: number | null; handlers: NativeCommandHandlers;
}) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [sendBadge] = useState(() => badgeSync());
  // Declared before "ready" so the listener is attached when the app starts sending.
  useEffect(() => {
    if (!inNativeApp()) return;
    const onCommand = (event: Event) => { runNativeCommand((event as CustomEvent).detail, handlersRef.current); };
    window.addEventListener(NATIVE_EVENT, onCommand);
    return () => window.removeEventListener(NATIVE_EVENT, onCommand);
  }, []);
  useEffect(() => { if (badge !== null) sendBadge(badge); }, [badge, sendBadge]);
  useEffect(() => { if (ready) postNative({ type: "ready" }); }, [ready]);
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** What the connect screen's Start Hivemind Server opens; the app intercepts it from the page too and cancels the navigation. */
export const SERVER_START_URL = "hivemind-server://start";

/** How the page opens a URL the app intercepts. Tests, which have no app to cancel it, replace `open`. */
export const appLinks = { open(url: string) { window.location.assign(url); } };

/**
 * Asks Hivemind.app to start Hivemind Server (the terminal broker lives in it): the app launches the
 * server app, or asks the running one to start its server. False in a browser, which is never offered it.
 */
export function startHivemindServer(win?: unknown): boolean {
  if (!nativeBridge(win)) return false;
  try {
    appLinks.open(SERVER_START_URL);
    return true;
  } catch {
    return false;
  }
}

// Terminals (the apps only; docs/terminal-broker.md#bridge). Agents launched
// from Hivemind run in tmux sessions that Hivemind Server.app's broker owns on
// the Mac; the app relays these messages to it, over a Unix socket on the Mac
// and through the remote gateway on iOS (docs/remote-access.md). The page side
// (requests, streams, the session list) is web/use-terminal.ts.

/** The DOM event terminal events arrive as: CustomEvent with detail {type, …}. */
export const TERMINAL_EVENT = "hivemind:terminal";

export const TMUX_INSTALL_COMMAND = "brew install tmux";
export const TMUX_INSTALL_HINT = `Install tmux: ${TMUX_INSTALL_COMMAND}`;
export const BROKER_UNAVAILABLE_HINT = "Start Hivemind Server to use terminals";
/**
 * Broker `unverified`: Hivemind.app could not prove this server is the one Hivemind Server started (a `hivemind
 * serve` run by hand, or something else on the port), so this window was opened without terminals
 * (docs/macos.md#verifying-the-server).
 */
export const SERVER_UNVERIFIED_HINT =
  "Terminals are off in this window: Hivemind couldn't verify that Hivemind Server started this server. Start the server from Hivemind Server, then reload.";
/** The same two hints on a device: tmux and the broker are the Mac's, and the device cannot start either. */
export const REMOTE_TMUX_INSTALL_HINT = `Install tmux on your Mac: ${TMUX_INSTALL_COMMAND}`;
export const REMOTE_BROKER_UNAVAILABLE_HINT = "Terminals need Hivemind Server running on your Mac";

/** Terminal.app (Open in Terminal) and Start Hivemind Server exist only for the page in Hivemind.app on the Mac. */
export const onMacDesktop = (platform: NativePlatform | null) => platform === "macos";

export const brokerUnavailableHint = (platform: NativePlatform | null) =>
  platform === "ios" ? REMOTE_BROKER_UNAVAILABLE_HINT : BROKER_UNAVAILABLE_HINT;
export const tmuxInstallHint = (platform: NativePlatform | null) => platform === "ios" ? REMOTE_TMUX_INSTALL_HINT : TMUX_INSTALL_HINT;
/**
 * Broker `unverified` on a device: the Mac's Hivemind Server could not verify its local terminal broker
 * (docs/remote-access.md#verified-server), so the gateway does not carry terminals.
 */
export const REMOTE_SERVER_UNVERIFIED_HINT =
  "Terminals are off: Hivemind Server on your Mac couldn't verify its terminal broker. Restart Hivemind Server on your Mac.";
export const serverUnverifiedHint = (platform: NativePlatform | null) =>
  platform === "ios" ? REMOTE_SERVER_UNVERIFIED_HINT : SERVER_UNVERIFIED_HINT;

/** The broker's limits (HivemindKit BrokerLimits); the app drops a message that breaks any. */
export const TERMINAL_BROKER_LIMITS = {
  launches: 24, commandBytes: 8 * 1024, titleChars: 200, pathBytes: 1024, agentChars: 64, requestIdChars: 64,
  inputBytes: 64 * 1024, streams: 16, cols: { min: 2, max: 1000 }, rows: { min: 1, max: 500 },
} as const;

/** One agent session to start, or reuse when it already runs (the same project + agent). */
export type TerminalSessionLaunch = {
  /** Project slug. */
  project: string;
  /** The agent's name; null for a new agent (the broker picks hm-<project>-new-<n>). */
  agent: string | null;
  /** tmux window / Terminal.app title, e.g. "Acme - Atlas". */
  title: string;
  /** Absolute, "~" or "~/…"; null or absent: the home folder. */
  cwd?: string | null;
  /** Shell text run by /bin/zsh -lc in the folder, as Copy would copy it (without its cd). */
  command: string;
  /**
   * The session the agent last reported (agent.terminalSession): the broker reuses it while it runs, so an agent
   * first launched as hm-<project>-new-<n> keeps it on Resume. A hint only; the broker never creates a session by it.
   */
  session?: string | null;
};

/** Page → app. `id` is the page's own request id (1–64 chars), echoed on the answer. */
export type TerminalMessage =
  /** Answered with terminal-launched. openInTerminal: also open a Terminal.app window attached to each (the Mac only). */
  | { type: "terminal-launch"; id?: string; launches: TerminalSessionLaunch[]; openInTerminal: boolean }
  /** Open a Terminal.app window attached to a running session (the Mac only). */
  | { type: "terminal-open"; session: string }
  /** Answered with terminal-attached, then terminal-output until terminal-exit. */
  | { type: "terminal-attach"; id?: string; session: string; cols: number; rows: number }
  /** `data` is base64, 1–64 KiB decoded (encodeTerminalInput splits a paste). */
  | { type: "terminal-input"; stream: number; data: string }
  | { type: "terminal-resize"; stream: number; cols: number; rows: number }
  /** Closes the stream; the session keeps running. */
  | { type: "terminal-detach"; stream: number }
  /**
   * The page drew `bytes` (decoded) of the stream's terminal-output. The app stops reading the broker while
   * more than 1 MiB of a window's output is not acked, and reads again at 256 KiB (HivemindKit TerminalOutputFlow).
   */
  | { type: "terminal-ack"; stream: number; bytes: number }
  /** Answered with terminal-killed. The page confirms with the user first. */
  | { type: "terminal-kill"; id?: string; session: string }
  /** terminal-status and sessions now, then sessions on every change. */
  | { type: "sessions-subscribe" }
  | { type: "sessions-unsubscribe" };

export type TerminalSessionInfo = {
  name: string;
  /** Project slug and agent name recorded at launch; labels only. Map agents by agent.terminalSession. */
  project: string | null;
  agent: string | null;
  alive: boolean;
  /** tmux clients attached: Terminal.app windows and in-app terminals alike. */
  attached: number;
  /** Unix ms. */
  createdAt: number;
};

export type TerminalLaunchFailure = { index: number; code: string; message: string };

/** App → page, as the detail of a TERMINAL_EVENT. */
export type TerminalEvent =
  /** `platform` is absent from Hivemind.app on the Mac, which predates it; nativePlatform reads that as "macos". */
  | { type: "terminal-status"; tmux: "available" | "missing" | "unknown"; broker: "connected" | "connecting" | "unavailable" | "unverified";
      platform: NativePlatform }
  | { type: "sessions"; items: TerminalSessionInfo[] }
  /** names[i] is launches[i]'s session, or null when it failed (see errors). */
  | { type: "terminal-launched"; id: string | null; names: (string | null)[]; created: string[]; errors: TerminalLaunchFailure[] }
  | { type: "terminal-attached"; id: string | null; stream: number; session: string }
  /** `data` is base64: decodeTerminalData, then xterm's write(Uint8Array). */
  | { type: "terminal-output"; stream: number; data: string }
  | { type: "terminal-exit"; stream: number; status: number | null }
  | { type: "terminal-killed"; id: string | null; session: string }
  /** `code` is a BrokerErrorCode (bad-message, no-such-session, tmux-missing, …). */
  | { type: "terminal-error"; id: string | null; code: string; message: string; stream: number | null };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isStream = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;
const nullableString = (value: unknown) => value === null || value === undefined ? null : typeof value === "string" ? value : undefined;
const nullableStream = (value: unknown) => value === null || value === undefined ? null : isStream(value) ? value : undefined;

function sessionInfo(value: unknown): TerminalSessionInfo | null {
  if (!isRecord(value)) return null;
  const name = terminalSessionName(value.name);
  const project = nullableString(value.project);
  const agent = nullableString(value.agent);
  if (!name || project === undefined || agent === undefined || typeof value.alive !== "boolean" ||
      !Number.isInteger(value.attached) || (value.attached as number) < 0 || typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt)) return null;
  return { name, project, agent, alive: value.alive, attached: value.attached as number, createdAt: value.createdAt };
}

/** A terminal event the page can act on, or null for anything unknown or malformed. */
export function parseTerminalEvent(detail: unknown): TerminalEvent | null {
  if (!isRecord(detail)) return null;
  const id = nullableString(detail.id);
  if (id === undefined) return null;
  switch (detail.type) {
    case "terminal-status": {
      const { tmux, broker } = detail;
      if (tmux !== "available" && tmux !== "missing" && tmux !== "unknown") return null;
      if (broker !== "connected" && broker !== "connecting" && broker !== "unavailable" && broker !== "unverified") return null;
      return { type: "terminal-status", tmux, broker, platform: nativePlatform(detail.platform) };
    }
    case "sessions": {
      if (!Array.isArray(detail.items)) return null;
      const items = detail.items.map(sessionInfo);
      return items.every(item => item !== null) ? { type: "sessions", items: items as TerminalSessionInfo[] } : null;
    }
    case "terminal-launched": {
      const { names, created, errors } = detail;
      if (!Array.isArray(names) || !names.every(name => name === null || terminalSessionName(name))) return null;
      if (!Array.isArray(created) || !created.every(name => terminalSessionName(name))) return null;
      if (!Array.isArray(errors) || !errors.every(e => isRecord(e) && Number.isInteger(e.index) &&
          typeof e.code === "string" && typeof e.message === "string")) return null;
      return { type: "terminal-launched", id, names: names as (string | null)[], created: created as string[],
        errors: (errors as TerminalLaunchFailure[]).map(({ index, code, message }) => ({ index, code, message })) };
    }
    case "terminal-attached": {
      const session = terminalSessionName(detail.session);
      return isStream(detail.stream) && session ? { type: "terminal-attached", id, stream: detail.stream, session } : null;
    }
    case "terminal-output":
      return isStream(detail.stream) && typeof detail.data === "string" && detail.data
        ? { type: "terminal-output", stream: detail.stream, data: detail.data } : null;
    case "terminal-exit": {
      const status = detail.status === null || detail.status === undefined ? null
        : Number.isInteger(detail.status) ? detail.status as number : undefined;
      return isStream(detail.stream) && status !== undefined ? { type: "terminal-exit", stream: detail.stream, status } : null;
    }
    case "terminal-killed": {
      const session = terminalSessionName(detail.session);
      return session ? { type: "terminal-killed", id, session } : null;
    }
    case "terminal-error": {
      const stream = nullableStream(detail.stream);
      return typeof detail.code === "string" && typeof detail.message === "string" && stream !== undefined
        ? { type: "terminal-error", id, code: detail.code, message: detail.message, stream } : null;
    }
    default:
      return null;
  }
}

/** Base64 of bytes, in slices so a large paste does not overflow the call stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * terminal-input payloads for what xterm reported (onData's string, as UTF-8,
 * or onBinary's bytes): base64, each at most the broker's input limit decoded.
 */
export function encodeTerminalInput(input: string | Uint8Array): string[] {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += TERMINAL_BROKER_LIMITS.inputBytes) {
    chunks.push(toBase64(bytes.subarray(i, i + TERMINAL_BROKER_LIMITS.inputBytes)));
  }
  return chunks;
}

/** How many bytes base64 `data` decodes to (padded, as the app sends it): what a terminal-ack acks. */
export function terminalDataLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length / 4) * 3 - padding);
}

/** The bytes of a terminal-output event; empty for data that is not base64. */
export function decodeTerminalData(data: string): Uint8Array {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

/** A size the broker takes: whole columns and rows within its limits, clamped. */
export function terminalSize(cols: number, rows: number): { cols: number; rows: number } {
  const clamp = (value: number, { min, max }: { min: number; max: number }) =>
    Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value) : min));
  return { cols: clamp(cols, TERMINAL_BROKER_LIMITS.cols), rows: clamp(rows, TERMINAL_BROKER_LIMITS.rows) };
}

const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** What Swift's CharacterSet.controlCharacters plus newlines refuse: Cc, Cf, line and paragraph separators. */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Why the app would refuse these session launches, or null when it takes them. */
export function terminalSessionLaunchProblem(launches: readonly TerminalSessionLaunch[]): string | null {
  const limits = TERMINAL_BROKER_LIMITS;
  if (launches.length === 0) return "Nothing to launch";
  if (launches.length > limits.launches) return `At most ${limits.launches} agents at once`;
  for (const launch of launches) {
    if (!PROJECT_SLUG.test(launch.project)) return "The project has no valid slug";
    const agent = launch.agent;
    if (agent !== null && (!agent.trim() || [...agent].length > limits.agentChars || CONTROL.test(agent))) {
      return "The agent name cannot name a terminal session";
    }
    if ([...launch.title].length > limits.titleChars || launch.title.includes("\0")) return "The title is too long";
    if (!launch.command.trim() || launch.command.includes("\0")) return "The command is empty";
    if (utf8Length(launch.command) > limits.commandBytes) return "The command is too long to launch; copy it instead";
    if (launch.session != null && !terminalSessionName(launch.session)) return "Not a Hivemind session";
    const cwd = launch.cwd;
    if (cwd && (!(cwd.startsWith("/") || cwd === "~" || cwd.startsWith("~/")) || cwd.includes("\0") ||
        utf8Length(cwd) > limits.pathBytes)) {
      return "Launching needs an absolute workspace path (/… or ~/…)";
    }
  }
  return null;
}
