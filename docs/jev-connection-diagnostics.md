# Explicit Jev connection diagnostics

In **Adaptive routing · Jev**, save the TypeSafe API key and other changes, then
click **Test Jev connection**. The test can run while adaptive routing is disabled.
Opening settings, saving, starting Hivemind and ordinary CI do not run a test.

The button makes one small synthetic TypeSafe request using the **saved** key and
current model alias. It can consume provider usage. It sends no project name,
request, repository content, history, task or coordination event. It does not
create messages, give any brain advice, wake workers, or append routing evidence.
A successful connection is not evidence of model quality or routing calibration.

The local Human API provides `GET /api/ui/adaptive-routing/connection-test` for an
opaque configuration revision and `POST` on that path with `{ "revision": "…" }`
for the explicit test. The existing authenticated Human serving boundary and local
UI origin checks apply; agent and bot Bearer credentials do not grant access.
The API does not accept a key, endpoint, prompt, model, timeout or retry count.

## Bounds and results

The transport uses the fixed TypeSafe endpoint, blocks redirects, makes no automatic
retries, and has a 3-second deadline including the response body and a 16 KiB actual
response limit. One test may be in flight per app. Another click from another tab
receives `busy` rather than creating another provider request.

Only fixed result categories cross the API: success, missing key, authorization
failure (401/403), rate limited (429), timeout, network failure, provider failure,
invalid contract, cancelled, changed settings or busy. Provider bodies, errors,
Authorization values and resolved-model text are not returned or logged. The UI
maps the allowlisted codes to static explanatory messages. No key hash or suffix
is used as a diagnostic revision; revisions are random and ephemeral.

Saving settings invalidates and aborts an in-flight test, even when values are
changed and restored. Changes to the local configuration file are also checked at
the beginning and end, including its file identity. The UI verifies the returned
revision again before presenting a result, clears results on edits/save or loss of
visibility/focus changes, and cancels on close. A displayed result describes that
completed test, not a continuously monitored guarantee of connectivity.

**Cancel test** aborts the local request. A request already received by TypeSafe may
still consume provider usage; cancellation cannot promise a refund. A retry always
requires another explicit click. No live smoke test is performed by these tests.

## Routing is separate

Normal Jev calls classify a Human request addressed to a brain and each brain action,
and return advice to the brain (see [Jev advice](adaptive-routing.md)). The
connection test does neither. A failed normal call only gives the brain
`unavailable` advice; nothing is enforced either way.

## Verification

`src/server/jev-diagnostics.test.ts` uses injected transports only, including
non-cooperative fetches and stalled streams. HTTP boundary tests exercise the actual
Human API with a fake provider. `web/jev-diagnostics.test.tsx` verifies explicit
clicks, inert save/render, cancellation, stale revisions and sanitized rendering.
Run through `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`.

Provider request/response contract: https://docs.typesafe.ai/api (checked 2026-09-23).
No claim about live credentials, model availability or billed usage is made.
