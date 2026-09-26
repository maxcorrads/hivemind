import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TerminalNotice } from "./TerminalNotice.tsx";
import {
  liveSession, terminalBlocker, terminalHub, touchKey, useTerminalState, withControl,
  type TerminalAttachment, type TerminalHub, type TerminalState,
} from "./use-terminal.ts";

/** What TerminalView draws on: xterm.js in the app (web/use-terminal-xterm.ts), a fake in tests. */
export type TerminalScreen = {
  readonly cols: number;
  readonly rows: number;
  /** The program asked for application cursor keys (arrows send ESC O x). */
  readonly applicationCursor: boolean;
  /** `drawn` runs once xterm has processed the bytes. */
  write: (data: Uint8Array, drawn?: () => void) => void;
  /** Keys, paste and mouse reports; returns the unsubscribe. */
  onInput: (listener: (data: string | Uint8Array) => void) => () => void;
  onResize: (listener: (cols: number, rows: number) => void) => () => void;
  /** Fits the grid to the host element; a resize, if any, arrives through onResize. */
  fit: () => void;
  focus: () => void;
  /** Re-reads the light/dark tokens. */
  retheme: () => void;
  dispose: () => void;
};
export type ScreenFactory = (host: HTMLElement) => Promise<TerminalScreen>;

// xterm and its CSS load on first use, as a chunk of their own.
const loadXterm = (): Promise<ScreenFactory> => import("./use-terminal-xterm.ts").then(module => module.createScreen);

type Phase =
  | { kind: "loading" }
  /** `again`: attaching after a lost stream, on the screen it had. */
  | { kind: "attaching"; again?: boolean }
  | { kind: "live" }
  /** The stream was lost (the broker connection dropped): the screen stays, and the view attaches again by itself. */
  | { kind: "reconnecting" }
  /** The attach client exited: "Session ended." once the broker no longer lists the session, else "Detached from …". */
  | { kind: "ended" }
  | { kind: "error"; message: string };

/**
 * A lost stream attaches again after these (ms, the last repeating). The first wait lets the app's status catch up:
 * it ends the streams just before it says the broker went, and an attach in between would only be refused.
 */
export const RECONNECT_DELAYS = [250, 1000, 2000, 5000] as const;

const noHub = () => () => {};
const noState = () => null;

/** The session is known not to run: the broker is connected and its list lacks it (or has it dead). */
const sessionGone = (state: TerminalState | null, session: string) =>
  state !== null && state.broker === "connected" && state.sessions !== null && !liveSession(state, session);

const TOUCH_KEYS = [
  { key: "esc", label: "Esc" }, { key: "tab", label: "Tab" }, { key: "ctrl-c", label: "^C", title: "Ctrl+C" },
  { key: "left", label: <ArrowLeft size={14} />, title: "Left" }, { key: "up", label: <ArrowUp size={14} />, title: "Up" },
  { key: "down", label: <ArrowDown size={14} />, title: "Down" }, { key: "right", label: <ArrowRight size={14} />, title: "Right" },
] as const;

/**
 * An interactive terminal attached to one tmux session through the broker: keys, paste, Ctrl+C, resize
 * and tmux's scrollback (mouse on). Several viewers, here or in Terminal.app, may share a session. On a
 * coarse pointer, and always in the iPhone/iPad app, a row of Esc/Ctrl/Tab/arrow keys shows under it.
 */
export function TerminalView({
  session, hub = terminalHub(), loadScreen = loadXterm, autoFocus = true, reconnectDelays = RECONNECT_DELAYS,
}: {
  session: string;
  hub?: TerminalHub | null;
  loadScreen?: () => Promise<ScreenFactory>;
  autoFocus?: boolean;
  /** How long a lost stream waits before each attempt to attach again, in ms; the last one repeats. */
  reconnectDelays?: readonly number[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const screen = useRef<TerminalScreen | null>(null);
  const attachment = useRef<TerminalAttachment | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [ctrl, setCtrl] = useState(false);
  const ctrlHeld = useRef(false);
  ctrlHeld.current = ctrl;
  const hubState = useSyncExternalStore(hub ? hub.subscribe : noHub, hub ? () => hub.state : noState, noState);
  /** Attaches the mounted screen to the session again (after a lost stream); set while a screen is up. */
  const reattach = useRef<(() => void) | null>(null);
  /** Attempts since the stream was last live, for reconnectDelays. */
  const attempts = useRef(0);

  useEffect(() => {
    const element = host.current;
    if (!hub || !element) return;
    let disposed = false;
    let teardown: Array<() => void> = [];
    setPhase({ kind: "loading" });
    void (async () => {
      let view: TerminalScreen;
      try {
        view = await (await loadScreen())(element);
      } catch {
        if (!disposed) setPhase({ kind: "error", message: "The terminal could not be loaded." });
        return;
      }
      if (disposed) { view.dispose(); return; }
      screen.current = view;
      // Each attach has its own handlers; a late event of an earlier one changes nothing. A lost stream keeps the
      // screen: attaching again to the same session makes tmux redraw it, as if nothing had happened.
      const attach = (again = false) => {
        if (disposed) return;
        const stream: TerminalAttachment = hub.attach(session, view.cols, view.rows, {
          output: (data, drawn) => view.write(data, drawn),
          attached: () => {
            if (disposed || attachment.current !== stream) return;
            attempts.current = 0;
            setPhase({ kind: "live" });
          },
          exit: () => { if (!disposed && attachment.current === stream) setPhase({ kind: "ended" }); },
          lost: () => { if (!disposed && attachment.current === stream) setPhase({ kind: "reconnecting" }); },
          error: error => {
            if (disposed || attachment.current !== stream) return;
            // Attaching again, only a session that is gone ends it; anything else (the broker not back yet) waits more.
            if (again && error.code !== "no-such-session") setPhase({ kind: "reconnecting" });
            else setPhase({ kind: "error", message: error.message });
          },
        });
        attachment.current = stream;
      };
      reattach.current = () => {
        if (disposed) return;
        attempts.current++;
        setPhase({ kind: "attaching", again: true });
        attach(true);
      };
      setPhase({ kind: "attaching" });
      attach();
      const offInput = view.onInput(data => {
        if (ctrlHeld.current && typeof data === "string") {
          data = withControl(data);
          setCtrl(false);
        }
        attachment.current?.input(data);
      });
      const offResize = view.onResize((cols, rows) => attachment.current?.resize(cols, rows));
      let frame = 0;
      const refit = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => view.fit()); };
      const resizes = typeof ResizeObserver === "function" ? new ResizeObserver(refit) : null;
      resizes?.observe(element);
      // web/use-theme.ts switches html.dark.
      const themes = new MutationObserver(() => view.retheme());
      themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      if (autoFocus) view.focus();
      teardown = [
        () => { cancelAnimationFrame(frame); resizes?.disconnect(); themes.disconnect(); },
        offInput, offResize,
        () => attachment.current?.detach(),
        () => view.dispose(),
      ];
    })();
    return () => {
      disposed = true;
      reattach.current = null;
      for (const step of teardown) step();
      screen.current = null;
      attachment.current = null;
    };
  }, [hub, session, attempt, loadScreen, autoFocus]);

  // Back from a lost stream: once the broker is connected again and lists the session as running, attach the same
  // screen to it. While the list is unknown this waits; a session that is gone ends here instead.
  const canReattach = phase.kind === "reconnecting" && hubState?.broker === "connected" && liveSession(hubState, session) !== null;
  useEffect(() => {
    if (!canReattach) return;
    const delay = reconnectDelays[Math.min(attempts.current, reconnectDelays.length - 1)] ?? 0;
    const timer = setTimeout(() => reattach.current?.(), delay);
    return () => clearTimeout(timer);
  }, [canReattach, reconnectDelays]);

  if (!hub) return null;
  // A key tap must not move focus off xterm: that would blur its textarea and hide the on-screen keyboard. WebKit on
  // iOS moves focus on the mousedown it synthesizes after a tap, which pointerdown's default does not cover.
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  const send = (key: (typeof TOUCH_KEYS)[number]["key"]) => {
    attachment.current?.input(touchKey(key, screen.current?.applicationCursor));
    screen.current?.focus();
  };
  // An iPad with a keyboard or trackpad reports a fine pointer, and its keyboards may lack Esc: the row stays.
  const platform = hub.state.platform;
  const gone = sessionGone(hubState, session);
  const shown = phase.kind === "reconnecting" && gone ? "ended" : phase.kind;
  const again = shown === "reconnecting" || (phase.kind === "attaching" && phase.again === true);
  const note = again ? "Reconnecting…"
    : shown === "loading" || shown === "attaching" ? `Connecting to ${session}…`
    : shown === "ended" ? (gone ? "Session ended." : `Detached from ${session}.`)
    : phase.kind === "error" ? phase.message : null;
  return (
    <div className="term" data-phase={shown} data-platform={platform ?? undefined}>
      {/* Keys stay in the terminal: Escape must not close a dialog, Ctrl+K must not open Jump to. ⌘ shortcuts pass.
          xterm opens in .term-fit, which has no padding or border, so the fit addon sizes the grid to the room it has. */}
      <div className="term-screen" aria-label={`Terminal: ${session}`} role="region"
        onKeyDown={event => { if (!event.metaKey) event.stopPropagation(); }}>
        <div className="term-fit" ref={host} />
      </div>
      {note && (
        <div className="term-note" role={shown === "error" ? "alert" : "status"}>
          <span>{note}</span>
          {(shown === "ended" || shown === "error") && (
            <button type="button" className="btn" onClick={() => setAttempt(n => n + 1)}>
              <RotateCcw size={13} aria-hidden="true" /> Reconnect
            </button>
          )}
        </div>
      )}
      <div className="term-keys" role="toolbar" aria-label="Terminal keys">
        <button type="button" aria-pressed={ctrl} title="Ctrl: hold for the next key"
          onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => { setCtrl(on => !on); screen.current?.focus(); }}>
          Ctrl
        </button>
        {TOUCH_KEYS.map(item => (
          <button key={item.key} type="button" title={"title" in item ? item.title : undefined}
            aria-label={"title" in item ? item.title : undefined}
            onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => send(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A session's terminal, or why there is none: Hivemind Server not running (with Start), tmux missing,
 * or the session no longer running. Nothing in a browser. Once the terminal shows, a broker that is only reconnecting
 * (connecting, unavailable, sessions not known yet) keeps it: the view says "Reconnecting…" and attaches again by itself.
 */
export function TerminalPanel({ session, loadScreen, reconnectDelays }: {
  session: string;
  loadScreen?: () => Promise<ScreenFactory>;
  reconnectDelays?: readonly number[];
}) {
  const state = useTerminalState();
  const [shown, setShown] = useState<string | null>(null);
  const blocker = state.native ? terminalBlocker(state) : null;
  const live = liveSession(state, session) !== null;
  const passing = blocker ? blocker.kind === "connecting" || blocker.kind === "server" : state.sessions === null;
  const keep = shown === session && passing;
  useEffect(() => {
    if (live) setShown(session);
    else if (!passing) setShown(null);
  }, [live, passing, session]);
  if (!state.native) return null;
  if (keep || (live && (!blocker || blocker.kind === "tmux"))) return <TerminalView key={session} session={session} loadScreen={loadScreen} reconnectDelays={reconnectDelays} />;
  if (blocker && blocker.kind !== "tmux") return <div className="term-empty"><TerminalNotice blocker={blocker} /></div>;
  if (!state.sessions) return <div className="term-empty"><TerminalNotice blocker={{ kind: "connecting", message: "Loading sessions…" }} /></div>;
  if (!liveSession(state, session)) {
    return <div className="term-empty"><p className="empty">{session} is not running.</p></div>;
  }
  return <TerminalView key={session} session={session} loadScreen={loadScreen} reconnectDelays={reconnectDelays} />;
}
