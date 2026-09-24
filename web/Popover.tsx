import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A small disclosure popover (members, fine print, status menu) built on <details>: keyboard and screen-reader
 * friendly without script, and closed by Escape or a click outside once open.
 */
export function Popover({ className, label, summary, children }: {
  className?: string;
  /** Accessible name of the toggle, also its hover title. */
  label: string;
  summary: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { if (ref.current) ref.current.open = false; };
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      ref.current?.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return <details ref={ref} className={`popover ${className ?? ''}`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label={label} title={label}>{summary}</summary>
    <div className="popover-body">{typeof children === 'function' ? children(close) : children}</div>
  </details>;
}

/** One "i" toggle holding the fine print that used to repeat inline on every card. */
export function InfoTip({ label, notes }: { label: string; notes: string[] }) {
  if (notes.length === 0) return null;
  return <Popover className="info-tip" label={label} summary="i">
    <ul role="note">{notes.map(note => <li key={note}>{note}</li>)}</ul>
  </Popover>;
}
