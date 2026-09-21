import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

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
