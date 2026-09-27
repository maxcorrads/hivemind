import { inNativeApp, parseTerminalEvent, postNative, TERMINAL_EVENT } from "./native-bridge.ts";

export type LaunchDecision = "approve" | "reject";

/**
 * Approval is a native-only operation. The app sends it through the verified broker to Hivemind Server.app,
 * which signs the request to Node. A Human browser session has read access to cards, but no approval route.
 */
export function decideLaunch(requestId: string, action: LaunchDecision, templateId?: string,
  win: Window = window, timeoutMs = 15_000): Promise<void> {
  if (!inNativeApp(win)) return Promise.reject(new Error("Open Hivemind.app or the iPhone/iPad app to decide launches."));
  const id = `approval-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      win.clearTimeout(timer);
      win.removeEventListener(TERMINAL_EVENT, onEvent);
      if (error) reject(error); else resolve();
    };
    const onEvent = (event: Event) => {
      const detail = parseTerminalEvent((event as CustomEvent).detail);
      if (!detail || !("id" in detail) || detail.id !== id) return;
      if (detail.type === "launcher-decided" && detail.requestId === requestId && detail.action === action) finish();
      else if (detail.type === "terminal-error") finish(new Error(
        typeof detail.message === "string" ? detail.message : "Hivemind Server refused the decision."));
    };
    const timer = win.setTimeout(() => finish(new Error(
      "Hivemind Server did not answer. Check whether the request is still pending before trying again.")), timeoutMs);
    win.addEventListener(TERMINAL_EVENT, onEvent);
    const message = action === "approve"
      ? { type: "launcher-approve" as const, id, requestId, ...(templateId ? { templateId } : {}) }
      : { type: "launcher-reject" as const, id, requestId };
    if (!postNative(message, win)) finish(new Error("Hivemind.app could not send the decision."));
  });
}
