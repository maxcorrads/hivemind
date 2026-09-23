import { useEffect, useState } from "react";
import type { Channel } from "../src/shared/types.ts";
import type { InboxBox, Sel } from "./selection.ts";

/** Keep in sync with the `@media (max-width: 960px)` block in styles.css. */
export const MOBILE_QUERY = "(max-width: 960px)";

export type MobileTab = "home" | "dms" | "activity" | "decisions";

/**
 * What a phone shows for a selection (#223): one screen at a time. `channel`
 * covers an open thread too; the thread replaces the channel once it has loaded.
 */
export type MobileScreen = MobileTab | "jev" | "search" | "channel";

export function mobileScreen(sel: Sel, searching: boolean): MobileScreen {
  if (searching) return "search";
  if (sel.kind === "inbox") return "activity";
  return sel.kind;
}

/** The highlighted bottom tab; the routing log and search live under Home, channels hide the bar. */
export function mobileTab(screen: MobileScreen): MobileTab | null {
  if (screen === "channel") return null;
  return screen === "jev" || screen === "search" ? "home" : screen;
}

/**
 * Where each bottom tab leads. Activity opens the project's For you view for
 * now; #225 replaces that view, so this is the only place that has to follow.
 */
export function tabTarget(tab: MobileTab, project: string, inboxBox: InboxBox): Sel {
  if (tab === "activity") return { kind: "inbox", project, box: inboxBox };
  return { kind: tab, project };
}

/** The back arrow of a channel: the list it was opened from, else the list that holds it. */
export function channelBack(channel: Pick<Channel, "type" | "project"> | undefined, from: Sel | null, project: string): Sel {
  if (from && from.kind !== "channel") return from;
  return { kind: channel?.type === "dm" ? "dms" : "home", project: channel?.project ?? project };
}

/** Whether the phone layout is active; follows window resizes. */
export function useMobile(): boolean {
  const [mobile, setMobile] = useState(() => Boolean(window.matchMedia?.(MOBILE_QUERY).matches));
  useEffect(() => {
    const media = window.matchMedia?.(MOBILE_QUERY);
    if (!media) return;
    const onChange = () => setMobile(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return mobile;
}
