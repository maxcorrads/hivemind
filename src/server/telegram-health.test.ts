import assert from "node:assert/strict";
import { test } from "node:test";
import { newerTelegramHealth, telegramDegraded } from "../../web/telegram-health.ts";

test("live Telegram failure wins over stale snapshots, including an event before initial snapshot", () => {
  const healthy = { revision: 1, failures: 0, quarantined: 0, lastError: null };
  const failed = { revision: 2, failures: 1, quarantined: 1, lastError: "Unauthorized" };
  let latest = newerTelegramHealth(null, failed);
  latest = newerTelegramHealth(latest, healthy);
  assert.deepEqual(latest, failed); assert.ok(telegramDegraded(latest));
  const recovered = { revision: 3, failures: 0, quarantined: 0, retrying: 0, lastError: null };
  latest = newerTelegramHealth(latest, recovered);
  assert.deepEqual(latest, recovered); assert.equal(telegramDegraded(latest), false);
  assert.deepEqual(newerTelegramHealth(undefined, undefined), {});
  assert.deepEqual(newerTelegramHealth(failed, undefined), failed);
  assert.equal(telegramDegraded({ retrying: 1 }), true);
  assert.equal(telegramDegraded(), false);
});

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";
import { initTelegramRouting } from "./telegram-routing.ts";
import { recordTelegramUpdateFailure } from "./telegram-inbox.ts";

test("an already-connected real WebSocket receives bounded health changes and recovery", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-health-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const server = startServer({ port: 0, hive, telegram: false });
  let socket: WebSocket | undefined;
  try {
    const port = await server.ready;
    const origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/ui/session`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(session.status, 200);
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin, cookie, "sec-fetch-site": "same-origin" },
    });
    const events: Array<{ type: string; payload: { revision: number; quarantined: number; lastError: string | null } }> = [];
    socket.on("message", raw => events.push(JSON.parse(String(raw))));
    await once(socket, "open");
    const snapshot = await (await fetch(`${origin}/api/ui/snapshot`, {
      headers: { origin, cookie, "x-hivemind-ui": "1" },
    })).json() as { telegram: { revision: number } };
    initTelegramRouting(hive.db, "bot:123");
    const nextHealth = () => new Promise<(typeof events)[number]>(resolve => {
      const onMessage = (raw: WebSocket.RawData) => {
        const event = JSON.parse(String(raw)) as (typeof events)[number];
        if (event.type === "telegram-health") { socket!.off("message", onMessage); resolve(event); }
      };
      socket!.on("message", onMessage);
    });
    const degraded = nextHealth();
    recordTelegramUpdateFailure(hive.db, { botKey: "bot:123", chatId: -1001, projectId: hive.projects.findProjectBySlug("acme")!.id },
      { update_id: 1, message: { malformed: true } }, "Malformed update", { permanent: true });
    hive.telegramAdmin.publishHealth();
    const failed = await degraded;
    assert.equal(failed.payload.quarantined, 1);
    assert.ok(failed.payload.revision > snapshot.telegram.revision);
    for (let i = 0; i < 20; i++) hive.telegramAdmin.publishHealth();
    const recovered = nextHealth();
    hive.telegramAdmin.discardUpdate(hive.telegramAdmin.quarantine()[0]!.id);
    const recovery = await recovered;
    assert.equal(recovery.payload.quarantined, 0);
    assert.ok(recovery.payload.revision > failed.payload.revision);
    assert.equal(events.filter(e => e.type === "telegram-health").length, 2);
    assert.equal(newerTelegramHealth(recovery.payload, failed.payload).quarantined, 0);
  } finally {
    socket?.terminate(); await server.shutdown(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
