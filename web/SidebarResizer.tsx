import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { clampSidebarWidth, readSidebarWidth, saveSidebarWidth, sidebarWidthBounds,
  SIDEBAR_DEFAULT_WIDTH, widthAfterSidebarKey, type SidebarWidthBounds } from "./sidebar-resize.ts";

type Drag = { pointerId: number; startX: number; startWidth: number; startPreference: number | null };

function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** Desktop sidebar separator: changes one shell token shared by rail and unified layouts. */
export function SidebarResizer({ threadOpen }: { threadOpen: boolean }) {
  const separatorRef = useRef<HTMLDivElement>(null);
  const [preferredWidth, setPreferredWidth] = useState<number | null>(() => readSidebarWidth(browserStorage()));
  const [bounds, setBounds] = useState<SidebarWidthBounds | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const currentBounds = bounds ?? { min: 220, max: 520 };
  const width = clampSidebarWidth(preferredWidth ?? SIDEBAR_DEFAULT_WIDTH, currentBounds);
  const shellElement = () => separatorRef.current?.closest<HTMLDivElement>(".shell") ?? null;

  useLayoutEffect(() => {
    const shell = shellElement();
    const sidebar = separatorRef.current?.parentElement;
    const desk = shell?.querySelector<HTMLElement>(".desk");
    if (!shell || !sidebar || !desk) return;
    const measure = () => {
      const next = sidebarWidthBounds(shell.getBoundingClientRect().right, sidebar.getBoundingClientRect().left, threadOpen);
      setBounds(previous => previous?.min === next.min && previous.max === next.max ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(shell);
    observer?.observe(desk); // A layout switch moves the sidebar without changing shell width.
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [threadOpen]);

  useLayoutEffect(() => {
    shellElement()?.style.setProperty("--sidebar-w", `${width}px`);
  }, [width]);
  useEffect(() => {
    const shell = shellElement();
    return () => { shell?.style.removeProperty("--sidebar-w"); };
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, startPreference: preferredWidth };
    setDragging(true);
  };
  const dragWidth = (event: PointerEvent<HTMLDivElement>, start: Drag) =>
    clampSidebarWidth(start.startWidth + event.clientX - start.startX, currentBounds);
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start?.pointerId !== event.pointerId) return;
    setPreferredWidth(dragWidth(event, start));
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const start = drag.current;
    if (start?.pointerId !== event.pointerId) return;
    const next = dragWidth(event, start);
    drag.current = null;
    setDragging(false);
    setPreferredWidth(cancelled ? start.startPreference : next);
    if (!cancelled) saveSidebarWidth(browserStorage(), next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      const start = drag.current;
      drag.current = null;
      setDragging(false);
      setPreferredWidth(start.startPreference);
      if (event.currentTarget.hasPointerCapture(start.pointerId)) event.currentTarget.releasePointerCapture(start.pointerId);
      return;
    }
    const next = widthAfterSidebarKey(event.key, width, currentBounds);
    if (next === null) return;
    event.preventDefault();
    setPreferredWidth(next);
    saveSidebarWidth(browserStorage(), next);
  };

  return <div ref={separatorRef} className={`sidebar-resizer${dragging ? " dragging" : ""}`}
    role="separator" tabIndex={0} aria-label="Resize sidebar" aria-orientation="vertical"
    aria-valuemin={currentBounds.min} aria-valuemax={currentBounds.max} aria-valuenow={width}
    aria-valuetext={`${width} pixels wide`}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove}
    onPointerUp={event => finishDrag(event, false)} onPointerCancel={event => finishDrag(event, true)}
    onKeyDown={onKeyDown} />;
}
