import { useEffect, useRef, useState } from "react";

type Theme = "light" | "dark";
const KEY = "hivemind-theme";
const darkQuery = () => window.matchMedia?.("(prefers-color-scheme: dark)");

/**
 * Light/dark theme. It follows the OS until the Human picks one, which is then saved in this browser;
 * later switches animate through a view transition unless motion is reduced.
 */
export function useTheme() {
  const [saved, setSaved] = useState<Theme | null>(() => {
    const value = localStorage.getItem(KEY);
    return value === "dark" || value === "light" ? value : null;
  });
  const [osDark, setOsDark] = useState(() => Boolean(darkQuery()?.matches));
  const theme: Theme = saved ?? (osDark ? "dark" : "light");
  const themePainted = useRef(false);

  useEffect(() => {
    const query = darkQuery();
    if (!query?.addEventListener) return;
    const onChange = (event: MediaQueryListEvent) => setOsDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark");
    if (!themePainted.current) {
      themePainted.current = true;
      apply();
      return;
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (!reduce && doc.startViewTransition) doc.startViewTransition(apply);
    else apply();
  }, [theme]);

  /** An explicit choice by the Human: saved, and no longer following the OS. */
  const setTheme = (next: Theme | ((current: Theme) => Theme)) => {
    const value = typeof next === "function" ? next(theme) : next;
    localStorage.setItem(KEY, value);
    setSaved(value);
  };

  return [theme, setTheme] as const;
}
