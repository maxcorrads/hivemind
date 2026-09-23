import { useEffect, useRef, useState } from "react";

/** Light/dark theme saved in this browser; later switches animate through a view transition unless motion is reduced. */
export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("hivemind-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const themePainted = useRef(false);

  useEffect(() => {
    const apply = () => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      localStorage.setItem("hivemind-theme", theme);
    };
    if (!themePainted.current) {
      themePainted.current = true;
      apply();
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (!reduce && doc.startViewTransition) doc.startViewTransition(apply);
    else apply();
  }, [theme]);

  return [theme, setTheme] as const;
}
