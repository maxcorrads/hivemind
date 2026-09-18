import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";
import type { Thread } from "../shared/types.ts";

function nextEvent(ws: WebSocket, type: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WebSocket timeout waiting for ${type}`));
    }, 8_000);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(String(data)) as Record<string, any>;
      if (event.type !== type) return;
      cleanup();
      resolve(event);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("error", onError);
      ws.off("message", onMessage);
    };
    ws.on("error", onError);
    ws.on("message", onMessage);
  });
}

async function postJson(base: string, url: string, body: unknown, token: string) {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
}

test("thread creation/list/update/reset stays camelCase across Hive HTTP and WebSocket", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-thread-contract-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const human = hive.getAgent("human");
  const root = hive.postMessage(human, { channel: "general", body: "root" });
  hive.postMessage(human, { channel: "general", threadId: root.id, body: "reply creates thread" });

  const created = hive.threadsInChannel("general").find((thread) => thread.id === root.id);
  assert.deepEqual(created, { id: root.id, channelId: "general", status: "open" });
  assert.equal((created as unknown as Record<string, unknown>).channel_id, undefined);

  const reader = hive.join({ role: "brain", focus: "thread-reader" });
  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const base = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

  t.after(async () => {
    ws.close();
    const closed = new Promise<void>((resolve) => started.server.once("close", () => resolve()));
    started.shutdown();
    await closed;
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const hello = await nextEvent(ws, "hello");
  assert.equal(hello.type, "hello");

  const listedRes = await fetch(`${base}/api/agent/channels/general/messages?meta=1`, {
    headers: { authorization: `Bearer ${reader.token}` },
  });
  assert.equal(listedRes.status, 200);
  const listed = (await listedRes.json()) as { threads: Thread[] };
  const externalCreated = listed.threads.find((thread) => thread.id === root.id);
  assert.deepEqual(externalCreated, { id: root.id, channelId: "general", status: "open" });
  assert.equal((externalCreated as unknown as Record<string, unknown>).channel_id, undefined);

  const liveState = new Map(listed.threads.map((thread) => [thread.id, thread]));
  const inProgressEvent = nextEvent(ws, "thread");
  const changed = await postJson(
    base,
    `/api/agent/threads/${root.id}/status`,
    { status: "in_progress" },
    reader.token,
  );
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.data.thread, { id: root.id, channelId: "general", status: "in_progress" });
  assert.equal(changed.data.thread.channel_id, undefined);

  const wsChanged = await inProgressEvent;
  assert.deepEqual(wsChanged.payload, { id: root.id, channelId: "general", status: "in_progress" });
  assert.equal(wsChanged.payload.channel_id, undefined);
  liveState.set(wsChanged.payload.id, wsChanged.payload as Thread);
  assert.equal(liveState.get(root.id)?.status, "in_progress");

  const resetEvent = nextEvent(ws, "thread");
  const reset = await postJson(
    base,
    `/api/agent/threads/${root.id}/status`,
    { status: null },
    reader.token,
  );
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data.thread, { id: root.id, channelId: "general", status: null });
  const wsReset = await resetEvent;
  assert.deepEqual(wsReset.payload, { id: root.id, channelId: "general", status: null });
  liveState.set(wsReset.payload.id, wsReset.payload as Thread);
  assert.equal(liveState.get(root.id)?.status, null);
});
