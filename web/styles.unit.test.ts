import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const css = read("./styles.css");
/** The sidebar's own rules (web/styles/nav.css) draw the message search and the closed-DM finder. */
const navCss = read("./styles/nav.css");
const channelCss = read("./styles/channel.css");
const overlaysCss = read("./styles/overlays.css");

function declaration(selector: string, property: string, source = css): string {
  const block = source.split(selector + " {")[1]?.split("}")[0];
  assert.ok(block, "missing CSS block for " + selector);
  const prefix = property + ":";
  const line = block.split(";").map(part => part.trim()).find(part => part.startsWith(prefix));
  assert.ok(line, "missing " + property + " in " + selector);
  return line.slice(prefix.length).trim();
}

/** A token's value in a theme, following var() aliases; html.dark falls back to the :root declarations. */
function token(scope: ":root" | "html.dark", name: string): string {
  let value: string;
  try { value = declaration(scope, name); } catch (error) {
    if (scope === ":root") throw error;
    value = declaration(":root", name);
  }
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  return alias ? token(scope, alias[1]!) : value;
}

/** Linear sRGB channels of a #rrggbb or oklch(L C H) colour (Björn Ottosson's OKLab matrices, clamped to gamut). */
function linearRgb(color: string): number[] {
  const oklch = color.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (oklch) {
    const [L, C, H] = oklch.slice(1).map(Number) as [number, number, number];
    const a = C * Math.cos(H * Math.PI / 180), b = C * Math.sin(H * Math.PI / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(channel => Math.min(1, Math.max(0, channel)));
  }
  assert.match(color, /^#[0-9a-f]{6}$/i);
  return [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
}

function luminance(color: string): number {
  const [r, g, b] = linearRgb(color);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** Gamma-encoded sRGB channels and alpha of a hex, rgb(a), oklch, transparent or `color-mix(in oklch, A p%, B)` colour. */
function srgba(color: string): { rgb: number[]; alpha: number } {
  color = color.trim();
  if (color === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
  const rgba = color.match(/^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/);
  if (rgba) return { rgb: rgba.slice(1, 4).map(channel => Number(channel) / 255), alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  const mix = color.match(/^color-mix\(in oklch, (.+) ([\d.]+)%, (.+)\)$/);
  if (mix) {
    const a = srgba(mix[1]!), b = srgba(mix[3]!), p = Number(mix[2]) / 100;
    // Premultiplied: mixing with transparent keeps the colour and scales its alpha.
    if (b.alpha === 0) return { rgb: a.rgb, alpha: a.alpha * p };
    const [l1, c1, h1] = oklch(a.rgb), [l2, c2, h2] = oklch(b.rgb);
    const turn = ((h2 - h1 + 540) % 360) - 180;
    const hue = c1 < 1e-4 ? h2 : c2 < 1e-4 ? h1 : h1 + turn * (1 - p);
    return { rgb: gamma(linearRgb(`oklch(${l1 * p + l2 * (1 - p)} ${c1 * p + c2 * (1 - p)} ${(hue + 360) % 360})`)), alpha: 1 };
  }
  return { rgb: gamma(linearRgb(color)), alpha: 1 };
}

const gamma = (linear: number[]) => linear.map(c => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const toLinear = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** OKLCH of gamma-encoded sRGB channels. */
function oklch(rgb: number[]): [number, number, number] {
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
}

/** Paints `layers` bottom-up (the first one opaque) and returns the hex colour a viewer sees. */
function paint(...layers: string[]): string {
  let out = srgba(layers[0]!).rgb;
  for (const layer of layers.slice(1)) {
    const { rgb, alpha } = srgba(layer);
    out = out.map((channel, index) => rgb[index]! * alpha + channel * (1 - alpha));
  }
  return "#" + out.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, "0")).join("");
}

/** A CSS value with every var(--token) replaced by its value in `scope`; `local` supplies rule-level custom properties. */
function resolve(scope: ":root" | "html.dark", value: string, local: Record<string, string> = {}): string {
  return value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => name in local ? resolve(scope, local[name]!, local) : token(scope, name));
}

const THEMES = [":root", "html.dark"] as const;
const BACKGROUNDS = ["--app", "--rail", "--surface", "--raised", "--sunk"];

test("text tokens keep readable contrast on every surface in both themes", () => {
  for (const scope of THEMES) {
    for (const ink of ["--ink", "--ink2", "--mute", "--accent", "--ok-ink", "--warn-ink", "--bad-ink"]) {
      for (const background of BACKGROUNDS) {
        const ratio = contrast(token(scope, ink), token(scope, background));
        assert.ok(ratio >= 4.5, `${scope} ${ink} on ${background} is only ${ratio.toFixed(2)}:1`);
      }
    }
    for (const [ink, fill] of [["--accent-ink", "--accent"], ["--badge-ink", "--badge"]] as const) {
      const ratio = contrast(token(scope, ink), token(scope, fill));
      assert.ok(ratio >= 4.5, `${scope} ${ink} on ${fill} is only ${ratio.toFixed(2)}:1`);
    }
  }
});

test("avatar initials keep readable contrast for every name hue, bots included, in both themes", () => {
  assert.equal(declaration(".avatar", "color"), "var(--avink)");
  assert.equal(declaration(".avatar", "background"), "oklch(var(--avl) 0.06 var(--h, 262))");
  assert.equal(declaration(".avatar.role-bot", "color"), "var(--ink2)");
  assert.equal(declaration(".avatar.role-bot", "background"), "var(--sunk)");
  for (const scope of THEMES) {
    const ink = token(scope, "--avink"), lightness = token(scope, "--avl");
    for (let hue = 0; hue < 360; hue += 5) {
      const ratio = contrast(ink, `oklch(${lightness} 0.06 ${hue})`);
      assert.ok(ratio >= 4.5, `${scope} avatar hue ${hue} is only ${ratio.toFixed(2)}:1`);
    }
    const bot = contrast(token(scope, "--ink2"), token(scope, "--sunk"));
    assert.ok(bot >= 4.5, `${scope} bot avatar contrast is only ${bot.toFixed(2)}:1`);
  }
});

test("the UI shell self-hosts its fonts and references no third-party host", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  for (const source of [html, css]) assert.doesNotMatch(source, /(?:https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9-]+\.[a-z]/i);
  const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
  for (const weight of [400, 500, 600, 700]) {
    assert.ok(faces.some(face => face.includes('"IBM Plex Sans"') && face.includes(`font-weight: ${weight};`)),
      `IBM Plex Sans ${weight} must be self-hosted`);
  }
  assert.match(declaration(":root", "--sans"), /^"IBM Plex Sans"/);
  assert.ok(faces.some(face => face.includes('"IBM Plex Mono"')), "IBM Plex Mono must be self-hosted");
  for (const face of faces) assert.match(face, /url\("\.\/fonts\/[^"]+\.woff2"\)/);
});

test("wax text uses the --wax-ink token with readable contrast in both themes", () => {
  for (const [scope, backgrounds] of [[":root", ["--desk", "--paper"]], ["html.dark", ["--desk", "--paper", "--composer"]]] as const) {
    const ink = token(scope, "--wax-ink");
    for (const background of backgrounds) {
      const ratio = contrast(ink, token(scope, background));
      assert.ok(ratio >= 4.5, `${scope} --wax-ink on ${background} is only ${ratio.toFixed(2)}:1`);
    }
  }
  for (const selector of [".text-btn", ".older"]) assert.equal(declaration(selector, "color"), "var(--wax-ink)");
});

test("keyboard focus stays visible on every control and main input", () => {
  assert.match(css, /:where\(button, a, input, textarea, select, summary, \[tabindex\]\):focus-visible \{ outline: 2px solid var\(--wax-ink\)/);
  for (const selector of [".rail .search", ".dm-picker input"]) {
    assert.throws(() => declaration(selector, "outline", navCss), /missing outline/, `${selector} must not suppress the focus ring`);
  }
  // The composer textarea is borderless; its box draws the ring instead.
  assert.match(css, /\.composer-box:has\(textarea:focus-visible\) \{ outline: 2px solid/);
});

test("no dead rules for the removed hive column or Jev enforcement remain", () => {
  assert.doesNotMatch(css, /\.hive\b/);
  assert.doesNotMatch(css, /\.routing-summary span/);
  assert.doesNotMatch(css, /\.routing-event\.warning/);
});

test("status chips stay readable on their tint over every surface they sit on, a hovered row included", () => {
  const text = declaration(".tone-chip:is(.accent, .ok, .warn, .bad, .muted)", "color");
  const tint = declaration(".tone-chip", "background");
  for (const scope of THEMES) {
    // The Routing log header is --sunk; stream cards are --raised; a message row gains --hover under the pointer.
    const grounds = [["--surface"], ["--raised"], ["--sunk"], ["--app"], ["--surface", "--hover"]].map(layers => layers.map(name => token(scope, name)));
    for (const variant of ["accent", "ok", "warn", "bad", "muted"]) {
      const local = variant === "accent" ? { "--tone": "var(--accent)", "--tone-ink": "var(--accent)" }
        : { "--tone": declaration(`.tone-chip.${variant}`, "--tone"), "--tone-ink": declaration(`.tone-chip.${variant}`, "--tone-ink") };
      for (const ground of grounds) {
        const ratio = contrast(paint(resolve(scope, text, local)), paint(...ground, resolve(scope, tint, local)));
        assert.ok(ratio >= 4.5, `${scope} .tone-chip.${variant} on ${ground.join(" + ")} is only ${ratio.toFixed(2)}:1`);
      }
    }
  }
  // The Routing log badge takes its colour from its chip variant, not an outcome rule of its own.
  for (const source of [css, overlaysCss]) assert.doesNotMatch(source, /\.jev-badge\.(applied|warning|kept|idle)\b/);
});

test("muted captions stay readable on the highlighted switcher option and the Jev strip's warning tint", () => {
  const hint = declaration(".switcher-options li.active .switcher-hint, .switcher-options li.active .switcher-enter", "color");
  const caption = declaration(".routing-strip.warning span", "color", channelCss);
  const strip = declaration(".routing-strip.warning", "background", channelCss);
  for (const scope of THEMES) {
    const onOption = contrast(paint(resolve(scope, hint)), paint(token(scope, "--raised"), token(scope, "--active")));
    assert.ok(onOption >= 4.5, `${scope} switcher hint on the active option is only ${onOption.toFixed(2)}:1`);
    const onStrip = contrast(paint(resolve(scope, caption)), paint(resolve(scope, strip)));
    assert.ok(onStrip >= 4.5, `${scope} Jev strip caption on its warning tint is only ${onStrip.toFixed(2)}:1`);
  }
});
