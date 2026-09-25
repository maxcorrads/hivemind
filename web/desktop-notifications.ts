import { useCallback, useRef, useState } from "react";
import type { Channel, Message } from "../src/shared/types.ts";
import { isHumanDm } from "./nav-model.ts";
import type { Sel } from "./selection.ts";

const KEY = "hivemind-notifications";

export type DesktopNotice = { title: string; body: string; tag: string; target: Sel };

/**
 * What a live event should tell the Human while the tab is in the background:
 * a message that mentions or is addressed to the Human, or a message in one of
 * the Human's DMs. Null for everything else.
 */
export function noticeFor(event: { type: string; payload: unknown }, channels: Channel[]): DesktopNotice | null {
  if (event.type === "message") {
    const message = event.payload as Message;
    if (message.authorId === "human" || message.kind !== "chat") return null;
    const channel = channels.find(item => item.id === message.channelId);
    const dm = Boolean(channel && isHumanDm(channel));
    if (!dm && !message.mentions?.includes("human") && !message.recipientIds?.includes("human")) return null;
    const body = message.body.length > 160 ? `${message.body.slice(0, 159)}…` : message.body;
    return { title: dm || !channel ? message.authorName : `${message.authorName} in #${channel.name}`,
      body: body || "(attachment)", tag: message.id,
      target: { kind: "channel", id: message.channelId, thread: message.threadId ?? undefined } };
  }
  return null;
}

const supported = () => typeof window !== "undefined" && "Notification" in window;

function loadOptIn() {
  try { return localStorage.getItem(KEY) === "on"; } catch { return false; }
}

/**
 * Opt-in browser notifications, remembered per browser. Nothing is shown
 * unless the Human switched them on and the browser granted permission, and
 * never while the Hivemind tab is focused.
 */
export function useDesktopNotifications(channels: Channel[], go: (next: Sel) => void) {
  const [optIn, setOptIn] = useState(loadOptIn);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    () => supported() ? Notification.permission : "unsupported");
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const goRef = useRef(go);
  goRef.current = go;
  const enabled = optIn && permission === "granted";

  const toggle = useCallback(async () => {
    if (!supported()) return;
    let next = !optIn;
    if (next && Notification.permission !== "granted") {
      const granted = await Notification.requestPermission();
      setPermission(granted);
      next = granted === "granted";
    }
    setOptIn(next);
    try { localStorage.setItem(KEY, next ? "on" : "off"); } catch { /* the choice lasts for this tab */ }
  }, [optIn]);

  const onLiveEvent = useCallback((event: { type: string; payload: unknown }) => {
    if (!enabled) return;
    const notice = noticeFor(event, channelsRef.current);
    if (!notice || (document.visibilityState === "visible" && document.hasFocus())) return;
    const shown = new Notification(notice.title, { body: notice.body, tag: notice.tag, icon: "/icon.png" });
    shown.onclick = () => { window.focus(); goRef.current(notice.target); shown.close(); };
  }, [enabled]);

  return { supported: permission !== "unsupported", enabled, blocked: permission === "denied", toggle, onLiveEvent };
}

export type DesktopNotifications = ReturnType<typeof useDesktopNotifications>;
