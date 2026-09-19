import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../client/http.ts";
import { waitUntilMail } from "./wait-loop.ts";
import type { WaitResult } from "../shared/types.ts";

const idle = (): WaitResult => ({ idle: true, next: "", you: {} as WaitResult["you"], control: [], mentions: [], messages: [] });
const mail = (): WaitResult => ({ ...idle(), idle: false, messages: [{ id: "fixture" } as WaitResult["messages"][number]] });

for (const error of [new TypeError("fetch failed"), new HttpError(503, "unavailable")]) {
  test(`default retry budget stops eight consecutive ${error.name} failures`, async () => {
    let calls = 0;
    const delays: number[] = [];
    await assert.rejects(waitUntilMail(async () => { calls++; throw error; }, {
      delay: async ms => { delays.push(ms); }, random: () => 1,
    }), error);
    assert.equal(calls, 8);
    assert.deepEqual(delays, [1500, 3000, 6000, 12000, 24000, 30000, 30000]);
  });
}

for (const [sample, expected] of [[0, 750], [1, 1500], [-1, 750], [2, 1500], [NaN, 1125]]) {
  test(`equal jitter clamps random sample ${sample}`, async () => {
    let calls = 0;
    const delays: number[] = [];
    await waitUntilMail(async () => { if (++calls === 1) throw new TypeError("fetch failed"); return mail(); }, {
      random: () => sample, delay: async ms => { delays.push(ms); },
    });
    assert.deepEqual(delays, [expected]);
  });
}

test("successful idle resets both counters and backoff without limiting idle polls", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await waitUntilMail(async () => {
    calls++;
    if (calls <= 7 || (calls >= 1009 && calls <= 1015)) throw new HttpError(500, "unavailable");
    return calls === 1016 ? mail() : idle();
  }, { random: () => 1, delay: async ms => { delays.push(ms); } });
  assert.equal(calls, 1016);
  assert.equal(result.idle, false);
  assert.equal(delays.length, 14);
  assert.deepEqual(delays.slice(0, 7), delays.slice(7));
});

for (const status of [401, 403, 404, 409]) {
  test(`typed HTTP ${status} errors never retry`, async () => {
    let calls = 0;
    const error = new HttpError(status, "not retryable");
    await assert.rejects(waitUntilMail(async () => { calls++; throw error; }, {
      delay: async () => { assert.fail("fatal error was retried"); },
    }), error);
    assert.equal(calls, 1);
  });
}

test("invalid budgets are rejected before sending any request", async () => {
  for (const key of ["maxServerErrors", "maxTransientErrors"] as const) {
    for (const value of [0, -1, 1.5, Infinity, NaN]) {
      await assert.rejects(waitUntilMail(async () => { assert.fail("invalid budget sent a request"); }, { [key]: value }), RangeError);
    }
  }
  for (const key of ["retryDelayMs", "maxRetryDelayMs"] as const) {
    for (const value of [-1, Infinity, NaN]) {
      await assert.rejects(waitUntilMail(async () => { assert.fail("invalid delay sent a request"); }, { [key]: value }), RangeError);
    }
  }
});
