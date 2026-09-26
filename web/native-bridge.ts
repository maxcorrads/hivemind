import { useEffect, useRef, useState } from "react";
import { hashFor, parseHash, type Sel } from "./selection.ts";

// The macOS app (macos/, contract in HivemindKit/Bridge.swift) loads this UI in
// a WKWebView and registers window.webkit.messageHandlers.hivemind. Everything
// here is inert in a browser: no handler, no messages, no listener.

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

/** One Terminal.app window the app opens: `command` runs in `cwd` (when set). */
export type TerminalLaunch = { title: string; cwd?: string | null; command: string };

export type NativeMessage =
  | { type: "ready" }
  /** `target` is the hash route the notice opens; the app hands it back as a "navigate" command on click. */
  | { type: "notify"; title: string; body: string; tag: string; target: string }
  | { type: "badge"; count: number }
  | { type: "launch-terminal"; launches: TerminalLaunch[] };

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
  const { command, hash } = detail as { command?: unknown; hash?: unknown };
  switch (command) {
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

/**
 * The app drops a whole launch-terminal message that breaks any of these
 * (HivemindKit/TerminalLaunch.swift), so the sheet checks them first.
 */
export const TERMINAL_LIMITS = { launches: 24, commandBytes: 8 * 1024, titleChars: 200, pathBytes: 1024 } as const;

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** Why the app would refuse these launches, or null when it takes them. */
export function terminalLaunchProblem(launches: readonly TerminalLaunch[]): string | null {
  if (launches.length === 0) return "Nothing to open";
  if (launches.length > TERMINAL_LIMITS.launches) return `At most ${TERMINAL_LIMITS.launches} terminals at once`;
  for (const launch of launches) {
    if (!launch.command.trim() || launch.command.includes("\0")) return "The command is empty";
    if (utf8Length(launch.command) > TERMINAL_LIMITS.commandBytes) return "The command is too long to open in Terminal; copy it instead";
    const cwd = launch.cwd;
    if (cwd && (!(cwd.startsWith("/") || cwd === "~" || cwd.startsWith("~/")) || cwd.includes("\0") ||
        utf8Length(cwd) > TERMINAL_LIMITS.pathBytes)) {
      return "Open in Terminal needs an absolute workspace path (/… or ~/…)";
    }
  }
  return null;
}

/**
 * Asks the app to open one Terminal window per launch. The title is cut to
 * the app's limit; anything else the app would refuse is not sent. False in a
 * browser, or when nothing was sent.
 */
export function launchInTerminal(launches: readonly TerminalLaunch[], win?: unknown): boolean {
  if (!nativeBridge(win) || terminalLaunchProblem(launches)) return false;
  return postNative({
    type: "launch-terminal",
    launches: launches.map(({ title, cwd, command }) => ({
      title: [...title.replace(/\0/g, "")].slice(0, TERMINAL_LIMITS.titleChars).join(""),
      ...(cwd ? { cwd } : {}),
      command,
    })),
  }, win);
}
