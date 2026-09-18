import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentRequest } from "../client/http.ts";
import { Hive } from "../server/hive.ts";
import type { WaitResult } from "../shared/types.ts";
import { waitUntilMail } from "./wait-loop.ts";

function mail(): WaitResult {
  return {
    idle: false,
    next: "fixture",
    you: {} as WaitResult["you"],
    control: [],
    mentions: [],
    messages: [{ id: "fixture" } as WaitResult["messages"][number]],
  };
}

test("cancellation propagates into an in-flight HTTP fetch without retrying", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });

  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    requestStarted();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("fixture expected fetch signal"));
        return;
      }
      const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;

  const ac = new AbortController();
  const pending = waitUntilMail(
    () => agentRequest<WaitResult>("POST", "/api/agent/wait", {}, "fixture-token", 60_000, ac.signal),
    { signal: ac.signal, retryDelayMs: 60_000 },
  );
  await started;
  ac.abort(new DOMException("cancelled while pending", "AbortError"));

  await assert.rejects(pending, /cancelled while pending/);
  assert.equal(calls, 1);
  assert.equal(getEventListeners(ac.signal, "abort").length, 0);
});

test("cancellation during the production retry delay clears its timer/listener and stops polling", async () => {
  const ac = new AbortController();
  let calls = 0;
  let failed!: () => void;
  const firstFailure = new Promise<void>((resolve) => {
    failed = resolve;
  });

  const pending = waitUntilMail(
    async () => {
      calls += 1;
      failed();
      throw new TypeError("fetch failed");
    },
    { signal: ac.signal, retryDelayMs: 60_000 },
  );

  await firstFailure;
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(getEventListeners(ac.signal, "abort").length, 1);
  ac.abort(new DOMException("cancelled in backoff", "AbortError"));
  await assert.rejects(pending, /cancelled in backoff/);
  assert.equal(calls, 1);
  assert.equal(getEventListeners(ac.signal, "abort").length, 0);
});

test("cancellation wins if mail becomes available in the same wait-loop turn", async () => {
  const ac = new AbortController();
  await assert.rejects(
    () =>
      waitUntilMail(
        async () => {
          ac.abort(new DOMException("cancelled same turn", "AbortError"));
          return mail();
        },
        { signal: ac.signal },
      ),
    /cancelled same turn/,
  );
});

test("cancelled and superseded Hive waits do not consume queued mail or leak signal listeners", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-wait-cancel-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => {
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const human = hive.getAgent("human");
  const joined = hive.join({ role: "worker", seniority: "mid" });
  const worker = joined.agent;
  const dm = hive.openDm(human, worker.name);

  const alreadyQueued = hive.postMessage(human, { channel: dm.id, body: "already queued before cancellation" });
  const pre = new AbortController();
  pre.abort(new DOMException("already cancelled", "AbortError"));
  const beforeCursor = (hive.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(worker.id) as {
    inbox_cursor: number;
  }).inbox_cursor;
  const preResult = await hive.wait(worker, 60_000, pre.signal);
  assert.equal(preResult.idle, true);
  assert.equal(getEventListeners(pre.signal, "abort").length, 0);
  const afterCursor = (hive.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(worker.id) as {
    inbox_cursor: number;
  }).inbox_cursor;
  assert.equal(afterCursor, beforeCursor);
  assert.equal(hive.inbox.currentSession(worker.id), undefined, "pre-cancelled wait does not create a session");
  const afterCancelled = await hive.wait(worker, 60_000);
  assert.equal(afterCancelled.messages.filter((message) => message.id === alreadyQueued.id).length, 1);

  // Delivery is now explicitly acknowledged. A wait never consumes its offered
  // batch just because the HTTP response returned successfully.
  assert.ok(afterCancelled.delivery);
  const sessionId = hive.inbox.currentSession(worker.id)!;
  hive.acknowledgeInbox(worker, sessionId, afterCancelled.delivery.id);

  const active = new AbortController();
  const cancelledWait = hive.wait(worker, 60_000, active.signal);
  assert.equal(getEventListeners(active.signal, "abort").length, 1);
  active.abort(new DOMException("cancel active wait", "AbortError"));
  const cancelled = await cancelledWait;
  assert.equal(cancelled.idle, true);
  assert.equal(getEventListeners(active.signal, "abort").length, 0);

  const queued = hive.postMessage(human, { channel: dm.id, body: "survives cancellation" });
  const next = await hive.wait(worker, 60_000);
  assert.equal(next.idle, false);
  assert.equal(next.messages.filter((message) => message.id === queued.id).length, 1);

  assert.ok(next.delivery);
  hive.acknowledgeInbox(worker, sessionId, next.delivery.id);

  const first = hive.wait(worker, 60_000);
  const replacement = hive.wait(worker, 60_000);
  await assert.rejects(first, /superseded/);
  const replacementMail = hive.postMessage(human, { channel: dm.id, body: "replacement receives me" });
  const replacementResult = await replacement;
  assert.equal(
    replacementResult.messages.filter((message) => message.id === replacementMail.id).length,
    1,
  );
});


test("cancellation during the routine batch delay clears its timer and does not poll again", async () => {
  const ac = new AbortController();
  let calls = 0;
  const pending = waitUntilMail(async () => {
    calls += 1;
    return { ...mail(), idle: true, messages: [], retryAfterMs: 60_000 };
  }, { signal: ac.signal });
  // The returned idle result queues the production delay in the next microtask.
  await Promise.resolve();
  assert.equal(getEventListeners(ac.signal, "abort").length, 1);
  ac.abort(new DOMException("cancelled routine batching", "AbortError"));
  await assert.rejects(pending, /cancelled routine batching/);
  assert.equal(calls, 1);
  assert.equal(getEventListeners(ac.signal, "abort").length, 0);
});
