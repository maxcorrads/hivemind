import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientWaitError, waitHasMail, waitUntilMail } from "./wait-loop.ts";
import { WAIT_NEXT, type WaitResult } from "../shared/types.ts";
import { agentRequest, HttpError } from "../client/http.ts";

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


test("agentRequest preserves HTTP status and wait treats auth failures as fatal", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "Invalid token", code: "invalid_token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        waitUntilMail(
          () => agentRequest<WaitResult>("POST", "/api/agent/wait", {}, "stale-token"),
          { delay: async () => undefined, maxTransientErrors: 10 },
        ),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 401);
        assert.equal(err.code, "invalid_token");
        assert.match(err.message, /Invalid token/);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("typed 403/404/409 are fatal while 429 and 5xx remain retryable", () => {
  for (const status of [403, 404, 409]) {
    assert.equal(isTransientWaitError(new HttpError(status, "arbitrary wording")), false);
  }
  assert.equal(isTransientWaitError(new HttpError(429, "slow down")), true);
  assert.equal(isTransientWaitError(new HttpError(503, "unavailable")), true);
});
