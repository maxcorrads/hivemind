import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Message } from "../shared/types.ts";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

test("a throwing post-commit listener neither fails the committed send nor skips later listeners", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-post-commit-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const logged = t.mock.method(console, "error", () => undefined);
  const seen: string[] = [];
  const throwing = () => { throw new Error("listener exploded"); };
  const later = (message: Message) => { seen.push(message.body); };
  // Registered before the server's web socket fan-out, so a rethrow would also skip it.
  hive.bus.on("message", throwing);
  const started = startServer({ port: 0, hive, telegram: false });
  hive.bus.on("message", later);
  t.after(async () => {
    hive.bus.off("message", throwing);
    hive.bus.off("message", later);
    await started.shutdown();
    hive.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${await started.ready}`;
  const joined = await fetch(`${base}/api/agent/join`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "brain", focus: "listeners" }),
  });
  assert.equal(joined.status, 200);
  const { token } = await joined.json() as { token: string };
  const sent = await fetch(`${base}/api/agent/channels/general/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ body: "committed despite a bad listener" }),
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal(seen.at(-1), "committed despite a bad listener");
  assert.ok(logged.mock.calls.some(call => /listener exploded/.test(call.arguments.join(" "))));
});

test("outside a transaction, a throwing listener is logged and every later listener still runs", t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-post-commit-direct-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.close(); rmSync(dir, { recursive: true, force: true }); });
  t.mock.method(console, "error", () => undefined);
  const ran: string[] = [];
  hive.bus.on("room", () => { throw new Error("first fails"); });
  hive.bus.once("room", () => { ran.push("once"); });
  hive.bus.on("room", ({ channelId }) => { ran.push(channelId); });
  assert.equal(hive.bus.emit("room", { channelId: "c1", archived: false }), true);
  hive.bus.emit("room", { channelId: "c2", archived: false });
  assert.deepEqual(ran, ["once", "c1", "c2"]);
});
