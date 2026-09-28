import assert from "node:assert/strict";
import { test } from "node:test";
import { clampSidebarWidth, readSidebarWidth, saveSidebarWidth, sidebarWidthBounds,
  SIDEBAR_DEFAULT_WIDTH, SIDEBAR_WIDTH_KEY, widthAfterSidebarKey } from "./sidebar-resize.ts";

test("desktop sidebar bounds leave space for the desk and an open thread in either layout", () => {
  const rail = sidebarWidthBounds(961, 60, true);
  assert.deepEqual(rail, { min: 220, max: 313 });
  assert.equal(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, rail), 264);
  assert.equal(961 - 60 - rail.max - 8 - 280, 300);
  const unified = sidebarWidthBounds(961, 0, true);
  assert.deepEqual(unified, { min: 220, max: 373 });
  assert.deepEqual(sidebarWidthBounds(1440, 60, true), { min: 220, max: 520 });
  assert.deepEqual(sidebarWidthBounds(1000, 60, false), { min: 220, max: 520 });
  assert.equal(clampSidebarWidth(999, rail), rail.max);
  assert.equal(clampSidebarWidth(100, rail), rail.min);
});

test("separator keys move right to grow, left to shrink, and jump to limits", () => {
  const bounds = { min: 220, max: 520 };
  assert.equal(widthAfterSidebarKey("ArrowRight", 300, bounds), 316);
  assert.equal(widthAfterSidebarKey("ArrowLeft", 300, bounds), 284);
  assert.equal(widthAfterSidebarKey("ArrowRight", 519, bounds), 520);
  assert.equal(widthAfterSidebarKey("ArrowLeft", 221, bounds), 220);
  assert.equal(widthAfterSidebarKey("Home", 300, bounds), 220);
  assert.equal(widthAfterSidebarKey("End", 300, bounds), 520);
  assert.equal(widthAfterSidebarKey("Escape", 300, bounds), null);
});

test("sidebar preference survives reload and damaged or unavailable storage is ignored", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(readSidebarWidth(storage), null);
  saveSidebarWidth(storage, 319.6);
  assert.equal(values.get(SIDEBAR_WIDTH_KEY), "320");
  assert.equal(readSidebarWidth(storage), 320);
  values.set(SIDEBAR_WIDTH_KEY, "Infinity");
  assert.equal(readSidebarWidth(storage), null);
  values.set(SIDEBAR_WIDTH_KEY, "-5");
  assert.equal(readSidebarWidth(storage), null);
  const unavailable = { getItem: (_key: string): string | null => { throw Error("denied"); },
    setItem: (_key: string, _value: string): void => { throw Error("denied"); } };
  assert.equal(readSidebarWidth(unavailable), null);
  assert.doesNotThrow(() => saveSidebarWidth(unavailable, 320));
});
