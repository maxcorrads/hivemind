import { useEffect, useRef, type ReactNode } from "react";

/** Dismiss only a complete, stationary backdrop click, never a drag out of the sheet. */
export function Modal({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const gesture = useRef<{ id: number; x: number; y: number; released: boolean } | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = root.current!;
    const focusable = () => Array.from(element.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
    )).filter(item => item.getClientRects().length > 0);
    if (!element.contains(document.activeElement)) (focusable()[0] ?? element).focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[data-modal-root]')).at(-1) !== element) return;
      if (event.key === "Escape" && !(event.target instanceof HTMLSelectElement) && !event.defaultPrevented && close.current) {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab") return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); element.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus(); };
  }, []);

  return <div className="modal" data-modal-root ref={root} tabIndex={-1}
    onPointerDownCapture={event => {
      gesture.current = event.target === event.currentTarget && event.button === 0 && event.isPrimary
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, released: false } : null;
    }}
    onPointerMoveCapture={event => {
      const start = gesture.current;
      if (start && (event.pointerId !== start.id || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6)) gesture.current = null;
    }}
    onPointerUpCapture={event => {
      const start = gesture.current;
      if (start && event.pointerId === start.id && event.target === event.currentTarget
        && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6) start.released = true;
      else gesture.current = null;
    }}
    onPointerCancel={() => { gesture.current = null; }}
    onClick={event => {
      const valid = gesture.current?.released && event.target === event.currentTarget;
      gesture.current = null;
      if (valid) onClose?.();
    }}>
    {children}
  </div>;
}
