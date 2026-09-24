import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function declaration(selector: string, property: string): string {
  const block = css.split(selector + " {")[1]?.split("}")[0];
  assert.ok(block, "missing CSS block for " + selector);
  const prefix = property + ":";
  const line = block.split(";").map(part => part.trim()).find(part => part.startsWith(prefix));
  assert.ok(line, "missing " + property + " in " + selector);
  return line.slice(prefix.length).trim();
}

function luminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map(channel =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

test("bot avatar initials keep readable contrast in light and dark themes", () => {
  assert.equal(declaration(".avatar.role-bot", "background"), "var(--dusk)");
  assert.equal(declaration("html.dark .avatar.role-bot", "color"), "var(--ink)");

  const lightRatio = contrast(declaration(":root", "--dusk"), declaration(".avatar", "color"));
  const darkRatio = contrast(declaration("html.dark", "--dusk"), declaration("html.dark", "--ink"));

  assert.ok(lightRatio >= 4.5, "light bot avatar contrast is only " + lightRatio.toFixed(2) + ":1");
  assert.ok(darkRatio >= 4.5, "dark bot avatar contrast is only " + darkRatio.toFixed(2) + ":1");
});

test("the UI shell self-hosts its fonts and references no third-party host", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  for (const source of [html, css]) assert.doesNotMatch(source, /(?:https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9-]+\.[a-z]/i);
  const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
  assert.ok(faces.some(face => face.includes('"Figtree"')), "Figtree must be self-hosted");
  assert.ok(faces.some(face => face.includes('"IBM Plex Mono"')), "IBM Plex Mono must be self-hosted");
  for (const face of faces) assert.match(face, /url\("\.\/fonts\/[^"]+\.woff2"\)/);
});

test("wax text uses the --wax-ink token with readable contrast in both themes", () => {
  for (const [scope, backgrounds] of [[":root", ["--desk", "--paper"]], ["html.dark", ["--desk", "--paper", "--composer"]]] as const) {
    const ink = declaration(scope, "--wax-ink");
    for (const background of backgrounds) {
      const ratio = contrast(ink, declaration(scope, background));
      assert.ok(ratio >= 4.5, `${scope} --wax-ink on ${background} is only ${ratio.toFixed(2)}:1`);
    }
  }
  for (const selector of [".text-btn", ".older", ".replies"]) assert.equal(declaration(selector, "color"), "var(--wax-ink)");
});

test("keyboard focus stays visible on every control and main input", () => {
  assert.match(css, /:where\(button, a, input, textarea, select, summary, \[tabindex\]\):focus-visible \{ outline: 2px solid var\(--wax-ink\)/);
  for (const selector of [".search", ".dm-picker input"]) {
    assert.throws(() => declaration(selector, "outline"), /missing outline/, `${selector} must not suppress the focus ring`);
  }
  // The composer textarea is borderless; its box draws the ring instead.
  assert.match(css, /\.composer-box:has\(textarea:focus-visible\) \{ outline: 2px solid/);
});

test("no dead rules for the removed hive column or Jev enforcement remain", () => {
  assert.doesNotMatch(css, /\.hive\b/);
  assert.doesNotMatch(css, /\.routing-summary span/);
  assert.doesNotMatch(css, /\.routing-event\.warning/);
});
