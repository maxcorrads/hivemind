import assert from "node:assert/strict";
import { test } from "node:test";
import { hasHumanSession, humanSessionCookie, isLoopbackHost, isTrustedBrowserOrigin } from "./local-auth.ts";

test("local Human auth accepts only loopback hosts and trusted browser origins", () => {
  assert.equal(isLoopbackHost("127.0.0.1:7420"), true);
  assert.equal(isLoopbackHost("localhost:7421"), true);
  assert.equal(isLoopbackHost("example.com:7420"), false);
  assert.equal(isTrustedBrowserOrigin("http://127.0.0.1:7420", "127.0.0.1:7420"), true);
  assert.equal(isTrustedBrowserOrigin("http://127.0.0.1:7421", "127.0.0.1:7420"), true);
  assert.equal(isTrustedBrowserOrigin("null", "127.0.0.1:7420"), false);
  assert.equal(isTrustedBrowserOrigin(undefined, "127.0.0.1:7420"), false);
  assert.equal(isTrustedBrowserOrigin("https://evil.example", "127.0.0.1:7420"), false);
});

test("Human session capability is parsed from HttpOnly cookie or explicit local header", () => {
  const cookie = humanSessionCookie("secret");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(hasHumanSession("other=x; hivemind_human=secret", "secret"), true);
  assert.equal(hasHumanSession(undefined, "secret", "secret"), true);
  assert.equal(hasHumanSession("hivemind_human=wrong", "secret"), false);
});
