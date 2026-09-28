import assert from "node:assert/strict";
import { test } from "node:test";
import { clampThreadWidth, defaultThreadWidth, readThreadWidth, saveThreadWidth, threadWidthBounds,
  THREAD_WIDTH_KEY, widthAfterKey } from "./thread-resize.ts";

test("desktop split keeps both panes usable at the mobile breakpoint and in a wide window", () => {
  // Rail layout: 60px project rail, 264px sidebar, 8px separator.
  const narrow = threadWidthBounds(961, 324);
  assert.deepEqual(narrow, { min: 280, max: 329 });
  assert.equal(clampThreadWidth(defaultThreadWidth(961), narrow), 329);
  assert.equal(961 - 324 - 8 - 329, 300);
  const wide = threadWidthBounds(1440, 324);
  assert.deepEqual(wide, { min: 280, max: 808 });
  assert.equal(clampThreadWidth(defaultThreadWidth(1440), wide), 420);
  assert.equal(clampThreadWidth(999, narrow), 329);
  assert.equal(clampThreadWidth(100, wide), 280);
  // Unified layout measures the desk edge, rather than assuming the rail width.
  assert.deepEqual(threadWidthBounds(961, 264), { min: 280, max: 389 });
});

test("separator keys move and jump within the measured bounds", () => {
  const bounds = { min: 280, max: 500 };
  assert.equal(widthAfterKey("ArrowLeft", 400, bounds), 416);
  assert.equal(widthAfterKey("ArrowRight", 400, bounds), 384);
  assert.equal(widthAfterKey("ArrowLeft", 499, bounds), 500);
  assert.equal(widthAfterKey("ArrowRight", 281, bounds), 280);
  assert.equal(widthAfterKey("Home", 400, bounds), 500);
  assert.equal(widthAfterKey("End", 400, bounds), 280);
  assert.equal(widthAfterKey("Escape", 400, bounds), null);
});

test("stored width survives reload and unavailable or damaged storage is ignored", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(readThreadWidth(storage), null);
  saveThreadWidth(storage, 419.6);
  assert.equal(values.get(THREAD_WIDTH_KEY), "420");
  assert.equal(readThreadWidth(storage), 420);
  values.set(THREAD_WIDTH_KEY, "NaN");
  assert.equal(readThreadWidth(storage), null);
  values.set(THREAD_WIDTH_KEY, "-20");
  assert.equal(readThreadWidth(storage), null);
  const unavailable = { getItem: (_key: string): string | null => { throw Error("denied"); },
    setItem: (_key: string, _value: string): void => { throw Error("denied"); } };
  assert.equal(readThreadWidth(unavailable), null);
  assert.doesNotThrow(() => saveThreadWidth(unavailable, 400));
});
