import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRequest, HttpError } from "./http.ts";
import { isTransientWaitError, waitUntilMail } from "../mcp/wait-loop.ts";
import type { WaitResult } from "../shared/types.ts";

function mail(): WaitResult {
  return {
    idle: false,
    next: "fixture",
    you: {} as WaitResult["you"],
    control: [],
    mentions: [],
    messages: [{ id: "m1" } as WaitResult["messages"][number]],
  };
}

test("real HTTP failures keep stable status/code across the client → MCP wait boundary", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 500 }));

  const bodies = [
    { name: "json-code", value: JSON.stringify({ error: "Denied by fixture", code: "fixture_denied" }) },
    { name: "json-no-code", value: JSON.stringify({ error: "Denied without code" }) },
    { name: "empty", value: "" },
    { name: "invalid-json", value: "{broken" },
    { name: "plain-html", value: "<html>Denied</html>" },
  ] as const;

  for (const status of [401, 403, 404, 409, 429, 500, 503]) {
    for (const body of bodies) {
      let calls = 0;
      fetchMock.mock.mockImplementation(async () => {
        calls += 1;
        return new Response(body.value, {
          status,
          headers: body.name.startsWith("json") ? { "content-type": "application/json" } : undefined,
        });
      });

      const fatal = [401, 403, 404, 409].includes(status);
      const expectedCalls = fatal ? 1 : 3;
      await assert.rejects(
        () =>
          waitUntilMail(
            () => agentRequest<WaitResult>("POST", "/api/agent/wait", {}, "fixture-token"),
            {
              delay: async () => undefined,
              maxServerErrors: 3,
              maxTransientErrors: 3,
            },
          ),
        (err: unknown) => {
          assert.ok(err instanceof HttpError, `status ${status}, body ${body.name}`);
          assert.equal(err.status, status);
          assert.equal(isTransientWaitError(err), !fatal);
          assert.equal(err.code, body.name === "json-code" ? "fixture_denied" : undefined);
          if (body.name === "json-code") assert.equal(err.message, "Denied by fixture");
          if (body.name === "json-no-code") assert.equal(err.message, "Denied without code");
          if (!body.name.startsWith("json")) assert.equal(err.message, `HTTP ${status}`);
          return true;
        },
      );
      assert.equal(calls, expectedCalls, `status ${status}, body ${body.name}`);
    }
  }
});

test("network failures retry by policy and recovery still returns mail", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(mail()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const result = await waitUntilMail(
    () => agentRequest<WaitResult>("POST", "/api/agent/wait", {}, "fixture-token"),
    { delay: async () => undefined, maxTransientErrors: 4 },
  );
  assert.equal(calls, 3);
  assert.equal(result.messages.length, 1);
});

test("malformed successful JSON remains a protocol error, not an HttpError", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("{broken", { status: 200 }));

  await assert.rejects(
    () => agentRequest("GET", "/fixture", undefined, "fixture-token"),
    (err: unknown) => err instanceof SyntaxError && !(err instanceof HttpError),
  );
});
