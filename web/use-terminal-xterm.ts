import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalScreen } from "./TerminalView.tsx";
import { terminalFont, terminalTheme } from "./use-terminal.ts";

// xterm.js behind TerminalView's TerminalScreen. Only TerminalView imports this,
// and only with import(), so the bundle (and its CSS) is a chunk of its own that
// a browser never loads: TerminalView renders only inside Hivemind.app.

export async function createScreen(host: HTMLElement): Promise<TerminalScreen> {
  const fontFamily = terminalFont();
  const fontSize = 12.5;
  // xterm measures one cell once; measure the font the UI uses, not its fallback.
  try { await document.fonts?.load(`${fontSize}px ${fontFamily}`); } catch { /* measured with the fallback */ }
  const term = new Terminal({
    fontFamily, fontSize, lineHeight: 1.15,
    theme: terminalTheme(),
    cursorBlink: true,
    // tmux keeps the session's history (history-limit 50000) and scrolls it with the mouse; this is xterm's own.
    scrollback: 5000,
    // Option types characters on many layouts (@ and # on Italian ones, for example); it is not Meta.
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    get applicationCursor() { return term.modes.applicationCursorKeysMode; },
    write: (data, drawn) => term.write(data, drawn),
    onInput(listener) {
      const text = term.onData(listener);
      // onBinary is a byte string (mouse reports in X10 mode): one char per byte.
      const binary = term.onBinary(data => listener(Uint8Array.from(data, ch => ch.charCodeAt(0) & 0xff)));
      return () => { text.dispose(); binary.dispose(); };
    },
    onResize(listener) {
      const subscription = term.onResize(({ cols, rows }) => listener(cols, rows));
      return () => subscription.dispose();
    },
    fit: () => { try { fit.fit(); } catch { /* not laid out */ } },
    focus: () => term.focus(),
    retheme: () => { term.options.theme = terminalTheme(); },
    dispose: () => term.dispose(),
  };
}
