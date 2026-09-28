import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import { clampThreadWidth, defaultThreadWidth, readThreadWidth, saveThreadWidth, threadWidthBounds,
  widthAfterKey, type ThreadWidthBounds } from "./thread-resize.ts";

type Drag = { pointerId: number; startX: number; startWidth: number };

function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** The desktop separator owns only the split width; it never changes thread scroll or content state. */
export function ThreadResizer({ shellRef }: { shellRef: RefObject<HTMLDivElement | null> }) {
  const [preferredWidth, setPreferredWidth] = useState<number | null>(() => readThreadWidth(browserStorage()));
  const [bounds, setBounds] = useState<ThreadWidthBounds | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const fallbackBounds = { min: 280, max: Math.max(280, window.innerWidth) };
  const currentBounds = bounds ?? fallbackBounds;
  const width = clampThreadWidth(preferredWidth ?? defaultThreadWidth(window.innerWidth), currentBounds);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const desk = shell.querySelector<HTMLElement>(".desk");
    if (!desk) return;
    const measure = () => {
      const next = threadWidthBounds(shell.getBoundingClientRect().right, desk.getBoundingClientRect().left);
      setBounds(previous => previous?.min === next.min && previous.max === next.max ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(shell);
    observer?.observe(desk); // The navigation layout can move the desk without resizing the shell.
    const sidebar = shell.querySelector<HTMLElement>(".rail");
    if (sidebar) observer?.observe(sidebar); // CSS may shrink the thread while keeping desk width fixed.
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [shellRef]);

  useLayoutEffect(() => {
    shellRef.current?.style.setProperty("--thread-w", `${width}px`);
  }, [shellRef, width]);
  useEffect(() => {
    const shell = shellRef.current;
    return () => { shell?.style.removeProperty("--thread-w"); };
  }, [shellRef]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    setDragging(true);
  };
  const dragWidth = (event: PointerEvent<HTMLDivElement>, start: Drag) =>
    clampThreadWidth(start.startWidth + start.startX - event.clientX, currentBounds);
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start?.pointerId !== event.pointerId) return;
    setPreferredWidth(dragWidth(event, start));
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const start = drag.current;
    if (start?.pointerId !== event.pointerId) return;
    const next = cancelled ? start.startWidth : dragWidth(event, start);
    drag.current = null;
    setDragging(false);
    setPreferredWidth(next);
    if (!cancelled) saveThreadWidth(browserStorage(), next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      const start = drag.current;
      drag.current = null;
      setDragging(false);
      setPreferredWidth(start.startWidth);
      if (event.currentTarget.hasPointerCapture(start.pointerId)) event.currentTarget.releasePointerCapture(start.pointerId);
      return;
    }
    const next = widthAfterKey(event.key, width, currentBounds);
    if (next === null) return;
    event.preventDefault();
    setPreferredWidth(next);
    saveThreadWidth(browserStorage(), next);
  };

  return <div className={`thread-resizer${dragging ? " dragging" : ""}`} role="separator" tabIndex={0}
    aria-label="Resize thread" aria-orientation="vertical" aria-valuemin={currentBounds.min}
    aria-valuemax={currentBounds.max} aria-valuenow={width} aria-valuetext={`${width} pixels wide`}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove}
    onPointerUp={event => finishDrag(event, false)} onPointerCancel={event => finishDrag(event, true)}
    onKeyDown={onKeyDown} />;
}
