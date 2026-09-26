import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TerminalNotice } from "./TerminalNotice.tsx";
import {
  liveSession, terminalBlocker, terminalHub, touchKey, useTerminalState, withControl,
  type TerminalAttachment, type TerminalHub,
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
  | { kind: "attaching" }
  | { kind: "live" }
  | { kind: "ended" }
  | { kind: "error"; message: string };

const TOUCH_KEYS = [
  { key: "esc", label: "Esc" }, { key: "tab", label: "Tab" }, { key: "ctrl-c", label: "^C", title: "Ctrl+C" },
  { key: "left", label: <ArrowLeft size={14} />, title: "Left" }, { key: "up", label: <ArrowUp size={14} />, title: "Up" },
  { key: "down", label: <ArrowDown size={14} />, title: "Down" }, { key: "right", label: <ArrowRight size={14} />, title: "Right" },
] as const;

/**
 * An interactive terminal attached to one tmux session through the broker: keys, paste, Ctrl+C, resize
 * and tmux's scrollback (mouse on). Several viewers, here or in Terminal.app, may share a session. On a
 * coarse pointer a row of Esc/Ctrl/Tab/arrow keys shows under it.
 */
export function TerminalView({ session, hub = terminalHub(), loadScreen = loadXterm, autoFocus = true }: {
  session: string;
  hub?: TerminalHub | null;
  loadScreen?: () => Promise<ScreenFactory>;
  autoFocus?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const screen = useRef<TerminalScreen | null>(null);
  const attachment = useRef<TerminalAttachment | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [ctrl, setCtrl] = useState(false);
  const ctrlHeld = useRef(false);
  ctrlHeld.current = ctrl;

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
      setPhase({ kind: "attaching" });
      const stream = hub.attach(session, view.cols, view.rows, {
        output: (data, drawn) => view.write(data, drawn),
        attached: () => { if (!disposed) setPhase({ kind: "live" }); },
        exit: () => { if (!disposed) setPhase({ kind: "ended" }); },
        error: error => { if (!disposed) setPhase({ kind: "error", message: error.message }); },
      });
      attachment.current = stream;
      const offInput = view.onInput(data => {
        if (ctrlHeld.current && typeof data === "string") {
          data = withControl(data);
          setCtrl(false);
        }
        stream.input(data);
      });
      const offResize = view.onResize((cols, rows) => stream.resize(cols, rows));
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
        () => stream.detach(),
        () => view.dispose(),
      ];
    })();
    return () => {
      disposed = true;
      for (const step of teardown) step();
      screen.current = null;
      attachment.current = null;
    };
  }, [hub, session, attempt, loadScreen, autoFocus]);

  if (!hub) return null;
  const send = (key: (typeof TOUCH_KEYS)[number]["key"]) => {
    attachment.current?.input(touchKey(key, screen.current?.applicationCursor));
    screen.current?.focus();
  };
  const note = phase.kind === "loading" || phase.kind === "attaching" ? `Connecting to ${session}…`
    : phase.kind === "ended" ? `Detached from ${session}.` : phase.kind === "error" ? phase.message : null;
  return (
    <div className="term" data-phase={phase.kind}>
      {/* Keys stay in the terminal: Escape must not close a dialog, Ctrl+K must not open Jump to. ⌘ shortcuts pass.
          xterm opens in .term-fit, which has no padding or border, so the fit addon sizes the grid to the room it has. */}
      <div className="term-screen" aria-label={`Terminal: ${session}`} role="region"
        onKeyDown={event => { if (!event.metaKey) event.stopPropagation(); }}>
        <div className="term-fit" ref={host} />
      </div>
      {note && (
        <div className="term-note" role={phase.kind === "error" ? "alert" : "status"}>
          <span>{note}</span>
          {(phase.kind === "ended" || phase.kind === "error") && (
            <button type="button" className="btn" onClick={() => setAttempt(n => n + 1)}>
              <RotateCcw size={13} aria-hidden="true" /> Reconnect
            </button>
          )}
        </div>
      )}
      <div className="term-keys" role="toolbar" aria-label="Terminal keys">
        <button type="button" aria-pressed={ctrl} title="Ctrl: hold for the next key"
          onPointerDown={event => event.preventDefault()} onClick={() => { setCtrl(on => !on); screen.current?.focus(); }}>
          Ctrl
        </button>
        {TOUCH_KEYS.map(item => (
          <button key={item.key} type="button" title={"title" in item ? item.title : undefined}
            aria-label={"title" in item ? item.title : undefined}
            onPointerDown={event => event.preventDefault()} onClick={() => send(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A session's terminal, or why there is none: Hivemind Server not running (with Start), tmux missing,
 * or the session no longer running. Nothing in a browser.
 */
export function TerminalPanel({ session, loadScreen }: { session: string; loadScreen?: () => Promise<ScreenFactory> }) {
  const state = useTerminalState();
  if (!state.native) return null;
  const blocker = terminalBlocker(state);
  if (blocker && blocker.kind !== "tmux") return <div className="term-empty"><TerminalNotice blocker={blocker} /></div>;
  if (!state.sessions) return <div className="term-empty"><TerminalNotice blocker={{ kind: "connecting", message: "Loading sessions…" }} /></div>;
  if (!liveSession(state, session)) {
    return <div className="term-empty"><p className="empty">{session} is not running.</p></div>;
  }
  return <TerminalView key={session} session={session} loadScreen={loadScreen} />;
}
