import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { loadClosedDms, saveClosedDms } from "./closed-dms.ts";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  },
});
beforeEach(() => store.clear());

test("closed DMs round-trip unique ids and tolerate corrupt storage", () => {
  assert.deepEqual(loadClosedDms(), []);
  saveClosedDms(["a", "b", "a"]);
  assert.equal(store.get("hivemind-closed-dms"), '["a","b"]');
  assert.deepEqual(loadClosedDms(), ["a", "b"]);
  store.set("hivemind-closed-dms", JSON.stringify(["x", "", 3, null]));
  assert.deepEqual(loadClosedDms(), ["x"]);
  store.set("hivemind-closed-dms", '{"a":1}');
  assert.deepEqual(loadClosedDms(), []);
  store.set("hivemind-closed-dms", "{broken");
  assert.deepEqual(loadClosedDms(), []);
});
