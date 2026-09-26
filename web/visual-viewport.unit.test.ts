import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { trackVisualViewport } from "./visual-viewport.ts";

/** A visual viewport that an on-screen keyboard shrinks, and the <html> style it writes to. */
function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const properties = new Map<string, string>();
  const frames: Array<() => void> = [];
  const viewport = {
    height: 844, offsetTop: 0,
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  };
  const target = {
    visualViewport: viewport,
    document: { documentElement: { style: {
      setProperty: (name: string, value: string) => { properties.set(name, value); },
      removeProperty: (name: string) => { properties.delete(name); },
    } } },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: () => {},
  };
  const flush = () => { for (const frame of frames.splice(0)) frame(); };
  return { target: target as unknown as Parameters<typeof trackVisualViewport>[0], viewport, listeners, properties, flush };
}

test("modals follow the visual viewport, so an on-screen keyboard does not cover a sheet's bottom", () => {
  const fake = fakeWindow();
  const stop = trackVisualViewport(fake.target);
  assert.equal(fake.properties.get("--visual-height"), "844px");
  assert.equal(fake.properties.get("--visual-top"), "0px");

  // The keyboard comes up: only the visual viewport shrinks, and iOS scrolls it down a little.
  fake.viewport.height = 480.4;
  fake.viewport.offsetTop = 120;
  fake.listeners.get("resize")!();
  fake.listeners.get("scroll")!();
  fake.flush();
  assert.equal(fake.properties.get("--visual-height"), "480px");
  assert.equal(fake.properties.get("--visual-top"), "120px");

  stop();
  assert.equal(fake.listeners.size, 0);
  assert.equal(fake.properties.size, 0, "unset again: the CSS falls back to the full viewport");
});

test("without a visual viewport nothing is tracked", () => {
  const stop = trackVisualViewport({ visualViewport: null } as unknown as Parameters<typeof trackVisualViewport>[0]);
  stop();
});

test("the modal and the sheets size themselves by the visual viewport", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const terminal = readFileSync(new URL("./styles/terminal.css", import.meta.url), "utf8");
  assert.match(css, /\.modal \{[^}]*inset: var\(--visual-top, 0px\) 0 auto;[^}]*height: var\(--visual-height, 100dvh\);/);
  assert.match(css, /\.sheet \{[^}]*max-height: calc\(var\(--visual-height, 100dvh\) - 2rem\);/);
  assert.match(terminal, /\.sessions-sheet \{[^}]*calc\(var\(--visual-height, 100dvh\) - 2rem\)/);
  assert.doesNotMatch(css + terminal, /[^(]100dvh - /, "no sheet is sized by the layout viewport alone");
});
