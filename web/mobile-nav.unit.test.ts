import assert from "node:assert/strict";
import { test } from "node:test";
import { channelBack, mobileScreen, mobileTab, tabTarget } from "./mobile-nav.ts";

test("each selection maps to one phone screen and its bottom tab", () => {
  assert.equal(mobileScreen({ kind: "home", project: "alpha" }, false), "home");
  assert.equal(mobileScreen({ kind: "dms", project: "alpha" }, false), "dms");
  assert.equal(mobileScreen({ kind: "inbox", project: "alpha" }, false), "activity");
  assert.equal(mobileScreen({ kind: "jev", project: "alpha" }, false), "jev");
  assert.equal(mobileScreen({ kind: "channel", id: "a", thread: "root" }, false), "channel");
  assert.equal(mobileScreen({ kind: "channel", id: "a" }, true), "search");

  assert.equal(mobileTab("activity"), "activity");
  assert.equal(mobileTab("jev"), "home");
  assert.equal(mobileTab("search"), "home");
  assert.equal(mobileTab("channel"), null);
});

test("tabs lead to the project's lists, Activity to its For you view", () => {
  assert.deepEqual(tabTarget("home", "alpha", "unread"), { kind: "home", project: "alpha" });
  assert.deepEqual(tabTarget("dms", "alpha", "unread"), { kind: "dms", project: "alpha" });
  assert.deepEqual(tabTarget("activity", "alpha", "all"), { kind: "inbox", project: "alpha", box: "all" });
});

test("a channel's back arrow returns to the list it came from, else to the list that holds it", () => {
  const from = { kind: "jev", project: "beta" } as const;
  assert.deepEqual(channelBack({ type: "public", project: "alpha" }, from, "alpha"), from);
  assert.deepEqual(channelBack({ type: "public", project: "alpha" }, null, "zeta"), { kind: "home", project: "alpha" });
  assert.deepEqual(channelBack({ type: "dm", project: "alpha" }, null, "zeta"), { kind: "dms", project: "alpha" });
  assert.deepEqual(channelBack(undefined, { kind: "channel", id: "x" }, "zeta"), { kind: "home", project: "zeta" });
});
