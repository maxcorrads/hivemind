import { useEffect, useState } from "react";
import { useMobile } from "./mobile-nav.ts";

export type Layout = "rail" | "unified";
const KEY = "hivemind-layout";

/**
 * Desktop navigation layout: the project rail beside the sidebar (default) or one sidebar under a top bar.
 * The Human's choice is saved in this browser like the theme. Phones keep their one-screen layout (#223),
 * so `unified` is false there and <html> only carries layout-unified while the top bar is on screen.
 */
export function useLayout() {
  const [layout, setSaved] = useState<Layout>(() => localStorage.getItem(KEY) === "unified" ? "unified" : "rail");
  const mobile = useMobile();
  const unified = layout === "unified" && !mobile;

  useEffect(() => {
    document.documentElement.classList.toggle("layout-unified", unified);
    return () => document.documentElement.classList.remove("layout-unified");
  }, [unified]);

  const setLayout = (next: Layout) => {
    localStorage.setItem(KEY, next);
    setSaved(next);
  };

  return { layout, setLayout, unified };
}
