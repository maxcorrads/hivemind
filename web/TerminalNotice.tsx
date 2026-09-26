import { Power } from "lucide-react";
import { useEffect, useState } from "react";
import { startHivemindServer } from "./native-bridge.ts";
import type { TerminalBlocker } from "./use-terminal.ts";

/**
 * Why terminals are unavailable: Hivemind Server is not reachable (with a button that starts it, as the
 * connect screen's does), tmux is missing, or the app is still connecting.
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
      <span>{blocker.kind === "tmux" ? <>Install tmux: <code>brew install tmux</code></> : blocker.message}</span>
      {blocker.kind === "server" && (
        <button type="button" className="btn" disabled={asked} onClick={() => { if (startHivemindServer()) setAsked(true); }}>
          <Power size={13} aria-hidden="true" />
          {asked ? "Starting…" : "Start Hivemind Server"}
        </button>
      )}
    </div>
  );
}
