import { DESK_MIN_WIDTH, SPLITTER_WIDTH, THREAD_MIN_WIDTH } from "./thread-resize.ts";

export const SIDEBAR_DEFAULT_WIDTH = 264;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_WIDTH_KEY = "hivemind-sidebar-width";

export type SidebarWidthBounds = { min: number; max: number };

/** The sidebar separator is inside its column, so only the thread separator uses extra space. */
export function sidebarWidthBounds(shellRight: number, sidebarLeft: number, threadOpen: boolean): SidebarWidthBounds {
  const space = shellRight - sidebarLeft - DESK_MIN_WIDTH - (threadOpen ? THREAD_MIN_WIDTH + SPLITTER_WIDTH : 0);
  const max = Math.max(0, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(space)));
  return { min: Math.min(SIDEBAR_MIN_WIDTH, max), max };
}

export function clampSidebarWidth(width: number, bounds: SidebarWidthBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

export function widthAfterSidebarKey(key: string, width: number, bounds: SidebarWidthBounds): number | null {
  switch (key) {
    case "ArrowRight": return clampSidebarWidth(width + 16, bounds);
    case "ArrowLeft": return clampSidebarWidth(width - 16, bounds);
    case "Home": return bounds.min;
    case "End": return bounds.max;
    default: return null;
  }
}

export function readSidebarWidth(storage: Pick<Storage, "getItem"> | null): number | null {
  try {
    const raw = storage?.getItem(SIDEBAR_WIDTH_KEY);
    if (!raw) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch { return null; }
}

export function saveSidebarWidth(storage: Pick<Storage, "setItem"> | null, width: number): void {
  try { storage?.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width))); } catch { /* Private storage may be unavailable. */ }
}
