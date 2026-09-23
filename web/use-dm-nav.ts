import { useCallback, useEffect, useState } from "react";
import { loadClosedDms, saveClosedDms } from "./closed-dms.ts";
import type { Sel } from "./selection.ts";

/** Closed DMs (saved in this browser), the reopen picker and the per-DM action menu of the sidebar. */
export function useDmNav(sel: Sel) {
  const [closedDms, setClosedDms] = useState<string[]>(loadClosedDms);
  const [dmPicker, setDmPicker] = useState<string | null>(null);
  const [dmPickQ, setDmPickQ] = useState("");
  const [dmMenu, setDmMenu] = useState<string | null>(null);

  const reopenDm = useCallback((channelId: string) => {
    setClosedDms((ids) => {
      if (!ids.includes(channelId)) return ids;
      const next = ids.filter((id) => id !== channelId);
      saveClosedDms(next);
      return next;
    });
  }, []);

  const closeDm = useCallback((channelId: string) => {
    setClosedDms((ids) => {
      if (ids.includes(channelId)) return ids;
      const next = [...ids, channelId];
      saveClosedDms(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (sel.kind !== "channel") return;
    reopenDm(sel.id);
  }, [sel]);

  useEffect(() => {
    if (!dmPicker && !dmMenu) return;
    const onDoc = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      const el = e.target as HTMLElement;
      if (el.closest(".dm-picker") || el.closest(".dm-row") || el.closest("[data-dm-open]")) return;
      setDmPicker(null);
      setDmMenu(null);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [dmPicker, dmMenu]);

  return { closedDms, reopenDm, closeDm, dmPicker, setDmPicker, dmPickQ, setDmPickQ, dmMenu, setDmMenu };
}

export type DmNav = ReturnType<typeof useDmNav>;
