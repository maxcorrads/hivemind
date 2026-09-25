import { useCallback, useEffect, useRef, useState } from "react";
import { createRequestGate } from "../src/shared/read-client.ts";
import { api, type NavStatus } from "./api.ts";

/** Live events that can change a roster status line. */
const REFRESH_ON = new Set(["hello", "task", "room", "project"]);

/**
 * Agent status lines. Loaded once, then refreshed
 * (coalesced) after the live events that can change them. A failed refresh
 * keeps the last known values: they are hints, never authority.
 */
export function useNavStatus(delay = 150) {
  const [status, setStatus] = useState<NavStatus>({ agentWork: {} });
  const gate = useRef(createRequestGate());
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    const request = gate.current.begin();
    api.navStatus(request.signal).then(next => { if (request.valid()) setStatus(next); }).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      gate.current.cancel();
    };
  }, [load]);

  const onLiveEvent = useCallback((event: { type: string }) => {
    if (!REFRESH_ON.has(event.type)) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; load(); }, delay);
  }, [load, delay]);

  return { ...status, onLiveEvent };
}
