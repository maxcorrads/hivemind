import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientWaitError, waitHasMail, waitUntilMail } from "./wait-loop.ts";
import { WAIT_NEXT, type WaitResult } from "../shared/types.ts";

function idle(): WaitResult {
  return { idle: true, next: WAIT_NEXT, you: {} as WaitResult["you"], control: [], mentions: [], messages: [] };
}

function mail(): WaitResult {
  return {
    idle: false,
    next: WAIT_NEXT,
    you: {} as WaitResult["you"],
    control: [],
    mentions: [],
    messages: [{ id: "m1" } as WaitResult["messages"][number]],
  };
}

test("empty idle-false payloads are not mail", () => {
  assert.equal(waitHasMail(idle()), false);
  assert.equal(waitHasMail({ ...idle(), idle: false }), false);
  assert.equal(waitHasMail(mail()), true);
});

test("a cancelled MCP wait does not retry or expose mail received after cancellation", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(waitUntilMail(async () => {
    calls++; controller.abort(new Error("cancelled by host")); return mail();
  }, { signal: controller.signal }), /cancelled by host/);
  assert.equal(calls, 1);
});

test("waitUntilMail does not return idle to the model", async () => {
  let calls = 0;
  const result = await waitUntilMail(async () => {
    calls += 1;
    if (calls < 3) return idle();
    return mail();
  });
  assert.equal(calls, 3);
  assert.equal(result.idle, false);
  assert.equal(result.messages.length, 1);
});

test("waitUntilMail keeps sleeping on idle-false with no mail items", async () => {
  let calls = 0;
  const result = await waitUntilMail(async () => {
    calls += 1;
    if (calls < 3) return { ...idle(), idle: false };
    return mail();
  });
  assert.equal(calls, 3);
  assert.equal(result.idle, false);
});

test("waitUntilMail retries fetch failed without throwing", async () => {
  let calls = 0;
  const result = await waitUntilMail(
    async () => {
      calls += 1;
      if (calls < 25) throw new Error("fetch failed");
      return mail();
    },
    { delay: async () => undefined },
  );
  assert.equal(calls, 25);
  assert.equal(result.idle, false);
});

test("auth errors are not swallowed", async () => {
  await assert.rejects(
    () => waitUntilMail(async () => {
      throw new Error("Join first with the join tool.");
    }),
    /Join first/,
  );
  assert.equal(isTransientWaitError(new Error("HTTP 401")), false);
  assert.equal(isTransientWaitError(new Error("HTTP 409 superseded")), false);
  assert.equal(isTransientWaitError(new Error("superseded")), false);
  assert.equal(isTransientWaitError(new Error("fetch failed")), true);
  assert.equal(isTransientWaitError(new Error("HTTP 500")), true);
});

test("transient errors stop after a bounded number of retries", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      waitUntilMail(
        async () => {
          calls += 1;
          throw new Error("fetch failed");
        },
        { delay: async () => undefined, maxTransientErrors: 8 },
      ),
    /fetch failed/,
  );
  assert.equal(calls, 8);
});

test("stable HTTP 5xx stops after a few retries", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      waitUntilMail(
        async () => {
          calls += 1;
          throw new Error("HTTP 500 boom");
        },
        { delay: async () => undefined, maxServerErrors: 5 },
      ),
    /HTTP 500/,
  );
  assert.equal(calls, 5);
});
