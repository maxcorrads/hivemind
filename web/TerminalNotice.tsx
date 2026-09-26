import { Power } from "lucide-react";
import { useEffect, useState } from "react";
import { TMUX_INSTALL_COMMAND, startHivemindServer } from "./native-bridge.ts";
import type { TerminalBlocker } from "./use-terminal.ts";

/**
 * Why terminals are unavailable: Hivemind Server is not reachable (with a button that starts it, as the
 * connect screen's does, when the page is in Hivemind.app on the Mac), the window was opened on a server Hivemind.app
 * could not verify, tmux is missing, or the app is still connecting.
 */
export function TerminalNotice({ blocker, compact }: { blocker: TerminalBlocker; compact?: boolean }) {
  const [asked, setAsked] = useState(false);
  // The server app takes a few seconds; offer the button again if nothing changed by then.
  useEffect(() => {
    if (!asked) return;
    const timer = window.setTimeout(() => setAsked(false), 8000);
    return () => window.clearTimeout(timer);
  }, [asked]);
  return (
    <div className={`term-notice ${blocker.kind} ${compact ? "compact" : ""}`} role="status">
      <span>{blocker.kind === "tmux" && blocker.message.endsWith(TMUX_INSTALL_COMMAND)
        ? <>{blocker.message.slice(0, -TMUX_INSTALL_COMMAND.length)}<code>{TMUX_INSTALL_COMMAND}</code></>
        : blocker.message}</span>
      {blocker.kind === "server" && blocker.canStart && (
        <button type="button" className="btn" disabled={asked} onClick={() => { if (startHivemindServer()) setAsked(true); }}>
          <Power size={13} aria-hidden="true" />
          {asked ? "Starting…" : "Start Hivemind Server"}
        </button>
      )}
    </div>
  );
}
