/**
 * Keeps `--visual-height` and `--visual-top` on <html> equal to the visual viewport's height and offset. On iOS
 * (Safari and the iPhone/iPad app's web view) the on-screen keyboard shrinks only the visual viewport: a fixed
 * modal sized with `dvh` stays full height, and whatever sits at the bottom of its sheet ends up under the
 * keyboard. That hid the in-app terminal's last rows and its Esc/Ctrl/Tab/arrow row while typing. Modals and
 * sheets size themselves with these (styles.css `.modal`, `.sheet`; terminal.css `.sessions-sheet`) and fall back
 * to the full viewport where they are unset. Returns a function that stops tracking.
 */
export function trackVisualViewport(target: Pick<Window, "visualViewport" | "document" | "requestAnimationFrame" | "cancelAnimationFrame"> = window): () => void {
  const viewport = target.visualViewport;
  if (!viewport) return () => {};
  const root = target.document.documentElement;
  let frame = 0;
  const update = () => {
    frame = 0;
    root.style.setProperty("--visual-height", `${Math.round(viewport.height)}px`);
    root.style.setProperty("--visual-top", `${Math.max(0, Math.round(viewport.offsetTop))}px`);
  };
  const schedule = () => { if (!frame) frame = target.requestAnimationFrame(update); };
  update();
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  return () => {
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    if (frame) target.cancelAnimationFrame(frame);
    root.style.removeProperty("--visual-height");
    root.style.removeProperty("--visual-top");
  };
}
