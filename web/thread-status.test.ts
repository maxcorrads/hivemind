import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelPayload } from "./api.ts";
import type { Thread } from "../src/shared/types.ts";
import { beginThreadLoad, receiveThreadSnapshot, receiveThreadStatus } from "./thread-state.ts";

const status = (value: Thread["status"]): Thread => ({ id: "root", channelId: "channel", status: value });
const pane = (): ChannelPayload => ({ channel: { id: "channel" } as ChannelPayload["channel"],
  threadId: "root", messages: [], threads: [status("open")], replyCounts: {} });

test("status received before the first thread snapshot is retained for that request only", () => {
  let view = beginThreadLoad(null, "channel", "root", 1);
  view = receiveThreadStatus(view, status("blocked"));
  assert.equal(view.pane, null);
  assert.equal(view.pendingLoad?.liveThread?.status, "blocked");
  view = receiveThreadSnapshot(view, "root", pane(), 1)!;
  assert.equal(view.pane?.threads[0]?.status, "blocked");
  assert.equal(view.pendingLoad, undefined);
  // A later authoritative refresh can legitimately report a different status.
  view = beginThreadLoad(view, "channel", "root", 2);
  view = receiveThreadSnapshot(view, "root", { ...pane(), threads: [status("done")] }, 2)!;
  assert.equal(view.pane?.threads[0]?.status, "done");
});

test("live status updates an open thread and wins over its pending HTTP snapshot", () => {
  let view = receiveThreadSnapshot(beginThreadLoad(null, "channel", "root", 1), "root", pane(), 1)!;
  view = beginThreadLoad(view, "channel", "root", 2);
  view = receiveThreadStatus(view, status("in_progress"));
  assert.equal(view.pane?.threads[0]?.status, "in_progress");
  view = receiveThreadStatus(view, status("blocked"));
  view = receiveThreadSnapshot(view, "root", pane(), 2)!;
  assert.deepEqual(view.pane?.threads, [status("blocked")]);
  assert.equal(receiveThreadSnapshot(view, "root", pane(), 1), view);
});

test("unrelated thread and channel status cannot alter or grow selected-thread state", () => {
  const view = receiveThreadSnapshot(beginThreadLoad(null, "channel", "root", 1), "root", pane(), 1)!;
  assert.equal(receiveThreadStatus(view, { ...status("done"), id: "other" }), view);
  assert.equal(receiveThreadStatus(view, { ...status("done"), channelId: "other" }), view);
  let pending = beginThreadLoad(view, "channel", "root", 2);
  for (let i = 0; i < 10_000; i++) pending = receiveThreadStatus(pending, status(i % 2 ? "blocked" : "open"));
  assert.equal(pending.pane?.threads.length, 1);
  assert.deepEqual(pending.pendingLoad?.liveThread, status("blocked"));
  assert.equal(pending.pendingLoad?.liveMessages.length, 0);
});
