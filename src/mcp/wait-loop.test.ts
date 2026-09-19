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

test("waitUntilMail honors an explicitly larger finite retry budget", async () => {
  let calls = 0;
  const result = await waitUntilMail(
    async () => {
      calls += 1;
      if (calls < 25) throw new Error("fetch failed");
      return mail();
    },
    { delay: async () => undefined, maxTransientErrors: 32 },
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

test('simultaneous reconnects use bounded exponential jitter and reset after a successful idle poll', async () => {
  const runs = await Promise.all([0, 0.5, 1].map(async random => {
    const delays: number[] = []; let calls = 0;
    await waitUntilMail(async () => {
      calls++;
      if (calls <= 6 || calls === 8) throw new Error('fetch failed');
      return calls === 7 ? idle() : mail();
    }, { retryDelayMs: 100, maxRetryDelayMs: 400, random: () => random,
      delay: async ms => { delays.push(ms); } });
    return delays;
  }));
  assert.deepEqual(runs[0], [50, 100, 200, 200, 200, 200, 50]);
  assert.deepEqual(runs[1], [75, 150, 300, 300, 300, 300, 75]);
  assert.deepEqual(runs[2], [100, 200, 400, 400, 400, 400, 100]);
});

test('fake clock staggers reconnects, keeps successful idle cadence, and cancellation interrupts backoff', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const calls: number[][] = [[], []];
  const runs = calls.map((times, i) => waitUntilMail(async () => {
    times.push(Date.now());
    if (times.length === 1) throw new Error('HTTP 503');
    return times.length === 2 ? idle() : mail();
  }, { retryDelayMs: 100, random: () => i }));
  await Promise.resolve(); t.mock.timers.tick(50);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(calls, [[1000, 1050, 1050], [1000]]);
  t.mock.timers.tick(50); await Promise.all(runs);
  assert.deepEqual(calls[1], [1000, 1100, 1100]);
  const controller = new AbortController();
  const blocked = waitUntilMail(async () => { throw new Error('fetch failed'); }, { signal: controller.signal });
  await Promise.resolve(); controller.abort(new Error('host cancelled'));
  await assert.rejects(blocked, /host cancelled/);
});

test('routine batching stays inside the wait tool and does not return an idle model turn', async () => {
  let calls = 0; const delays: number[] = [];
  const result = await waitUntilMail(async () => ++calls === 1 ? { ...idle(), retryAfterMs: 175 } : mail(),
    { delay: async ms => { delays.push(ms); } });
  assert.equal(result.idle, false); assert.equal(calls, 2); assert.deepEqual(delays, [175]);
});
