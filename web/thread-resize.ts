/** Desktop split dimensions in CSS pixels. The rail is measured rather than assumed. */
export const THREAD_MIN_WIDTH = 280;
export const DESK_MIN_WIDTH = 300;
export const SPLITTER_WIDTH = 8;
export const THREAD_WIDTH_KEY = "hivemind-thread-width";

export type ThreadWidthBounds = { min: number; max: number };

export function threadWidthBounds(shellRight: number, deskLeft: number): ThreadWidthBounds {
  const available = Math.max(0, shellRight - deskLeft - SPLITTER_WIDTH);
  const max = Math.max(0, Math.floor(available - DESK_MIN_WIDTH));
  return { min: Math.min(THREAD_MIN_WIDTH, max), max };
}

export function clampThreadWidth(width: number, bounds: ThreadWidthBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

/** Matches the pre-resize desktop default from styles/thread.css. */
export function defaultThreadWidth(viewportWidth: number): number {
  return Math.min(420, viewportWidth * 0.38);
}

export function widthAfterKey(key: string, width: number, bounds: ThreadWidthBounds): number | null {
  switch (key) {
    case "ArrowLeft": return clampThreadWidth(width + 16, bounds);
    case "ArrowRight": return clampThreadWidth(width - 16, bounds);
    case "Home": return bounds.max;
    case "End": return bounds.min;
    default: return null;
  }
}

export function readThreadWidth(storage: Pick<Storage, "getItem"> | null): number | null {
  try {
    const raw = storage?.getItem(THREAD_WIDTH_KEY);
    if (!raw) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch { return null; }
}

export function saveThreadWidth(storage: Pick<Storage, "setItem"> | null, width: number): void {
  try { storage?.setItem(THREAD_WIDTH_KEY, String(Math.round(width))); } catch { /* Private storage may be unavailable. */ }
}
