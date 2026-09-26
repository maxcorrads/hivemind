# Local Human security boundary

## Threat model and supported access

Hivemind remains local-first: no accounts, passwords, remote login, or external
identity provider. The production listener remains bound to `127.0.0.1`. The
supported browser authorities are canonical `127.0.0.1`, `localhost`, and bracketed
`[::1]` when used by a loopback proxy. Authority parsing and socket-port handling
are also exercised against a real IPv6 test listener; this does not change the
production listener into a dual-stack/LAN listener.

The boundary protects against malicious websites/tabs, cross-origin writes,
cross-site WebSocket hijacking, DNS rebinding through hostile Host headers,
malformed/opaque origins, and accidental cross-instance session replacement.
It does **not** authenticate an OS user or sandbox native local processes. Any
local process able to connect can imitate the trusted bootstrap headers. This
includes another OS user where local socket access is allowed. Cookies are not
confidential between ports; a malicious local service, same-origin XSS, browser
extension with sufficient privileges, or an already stolen current capability
is outside this boundary. Use OS isolation for untrusted local processes.

## Server policy

`startServer` installs `LocalHumanAuth` at the Node HTTP ingress, before **both**
the Hono router and static UI. The same process-local object validates WebSocket
upgrades before the connection enters the broadcast set. `createApp` is an
internal router, not an independently secured transport; an additional server
adapter must install the same boundary before exposing it.

Host parsing rejects credentials, paths, queries, fragments, noncanonical numeric
IP forms, trailing dots, and invalid ports. A supplied Origin must exactly equal
the canonical HTTP origin of Host, including the hostname and port. Missing,
empty, `null`, malformed, cross-port, and cross-host origins cannot bootstrap a
session or open a WebSocket. Forwarded/proxy headers never manufacture trust.
HTTPS termination, remote reverse proxies, and arbitrary localhost aliases are
not implicitly authorized.

| Request | Requirements |
| --- | --- |
| `POST /api/ui/session` | Exact trusted Origin, JSON media type, local Host; no prior session. |
| Human reads/writes/files | Current Human capability plus a trusted browser context. |
| Browser agent requests, including join/name resume | Host/Origin/Fetch Metadata checked before handler execution; JSON for JSON mutations. |
| Native agent requests without Origin/Fetch Metadata | Existing agent bearer authentication; join/resume behavior unchanged. |
| `GET /api/health` and `GET /api/health/instance?nonce=<64 hex>` | No Human capability needed; local Host/browser-origin policy still applies. The instance challenge answers `{proof}` (`no-store`) only when the server was started with a per-start secret by Hivemind Server.app, 404 otherwise, 400 for a malformed nonce ([Verifying the server](macos.md#verifying-the-server)). |
| `/ws` upgrade | Exact path, trusted Origin and current Human capability; no query authentication. |

SameSite cookies are not a substitute for origin checks: ports share a site.
`Sec-Fetch-Site: same-site` and `cross-site` are rejected on API/WS requests even
with a valid cookie. Same-origin GET/image requests may legitimately omit Origin;
they need same-origin Fetch Metadata, a user-initiated `none` GET/HEAD context, or
the non-simple `X-Hivemind-UI: 1` request header used by the web client. A native
Human client can explicitly supply its current capability in `X-Hivemind-Human`.
Agent bearer tokens are never accepted as Human sessions. Browsers lacking Fetch
Metadata can use normal web API calls, but not context-free inline file requests.

POST/PUT/PATCH JSON media types must match `application/json` (parameters allowed),
not a prefix such as `application/jsonp`. Only the exact POST file-upload routes
are binary exceptions. DELETE retains its existing body-free contract. Preflights
are side-effect free and require a trusted exact Origin. API/session/error
responses are `no-store`; the production and Vite documents deny framing. Error
responses do not echo cookies, capability headers, or request URLs.

## Capability lifecycle, tabs, instances, and Vite

The capability uses 32 cryptographically random bytes, stays only in server memory
and an HttpOnly, SameSite=Strict, host-only session cookie, and is never returned
in JSON, stored in localStorage, placed in URLs, or logged by this boundary. HTTP
loopback does not support a Secure-cookie transport promise. Cookie/header
comparison validates the generated format and uses constant-time equality.
Malformed percent escapes do not throw; duplicate-name cookies fail closed.

The cookie name is `hivemind_human_<backend-listener-port>`. The port comes from
the actual socket, **not** Host, `Forwarded`, or `X-Forwarded-*`. Two listeners
therefore coexist in the browser's host cookie jar. Multiple tabs/bootstrap
requests do not rotate each other's capability. Restart creates a new secret but
keeps the same port-qualified cookie name, so refreshing replaces the stale
cookie instead of accumulating one per restart. There is no idle expiration;
server shutdown/restart revokes the capability, and browser session-cookie
retention follows browser policy (including possible session restore).

Vite's `/api` and `/ws` proxies explicitly preserve the original Host and Origin.
No universal development-port exception and no `rewriteWsOrigin` are used. A
proxy UI and the direct UI on the same hostname can share the backend-qualified
cookie. Cross-origin direct access from one port to another is not supported;
use the same-origin Vite proxy. Changing a backend port creates a different
cookie name; old cookies are harmless but may remain until the browser clears
session state. Do not configure a proxy that rewrites an untrusted Origin into a
trusted one.

## Recovery and mutation safety

The browser coordinator shares a single in-flight bootstrap among concurrent
callers, clears failed bootstrap state, and times out a bootstrap after ten
seconds. Abort of one caller does not cancel another caller's shared bootstrap
or cause the aborted mutation to be sent.

Only the ingress gate's **pre-handler** `401` carries
`X-Hivemind-Session-Required: 1`. That marker allows one rebootstrap and at most one
replay of a replayable JSON/File request. Generic handler 401s, 403s, 5xx responses,
and ambiguous network failures never trigger automatic mutation replay.
Generation tracking prevents a late stale 401 from invalidating a newer session.
Stream bodies are not replayed.

Every WebSocket connection attempt first refreshes the session because browser
WebSockets do not reveal the HTTP status of a rejected handshake. Failed bootstrap
or handshake schedules the existing reconnect delay. Disposing a connection
clears its timer and prevents an in-flight bootstrap from opening a new socket.
Shutdown terminates live subscriptions, removes bus listeners and waits for the
network servers to close. Database ownership is unchanged: callers close their
Hive after other integrations have drained.

## Regression and adversarial review map

- `local-auth.test.ts`: strict authorities, Origin/Fetch Metadata, cookie entropy
  and parsing, pre-handler denial, media types, proxy spoofing, path/query bypasses,
  two listeners/tabs, IPv4/IPv6 and independent WS policy.
- `local-security.test.ts`: actual Hivemind HTTP/WS handshakes, authorized project
  and DM events, denied join/resume with unchanged identity/token hashes, native
  authorization, restart with database reopen, two Hivemind listeners, and actual
  Vite HTTP/WS proxying. These are transport tests, not browser-engine tests.
- `web/human-session.test.ts`: concurrent/late responses, failed bootstrap and
  restart recovery, safe replay limits, cancellation/deadline cleanup and socket
  reconnect/disposal with deterministic mocks rather than sleeps.
- `web/extensibility-session.test.ts`: real protected bot/plugin/credential routes,
  zero mutations or Configure execution after rejected requests, credential/project
  scope, durable event replay, shared restart recovery, and no mutation replay after
  an ambiguous committed response.
- `browser-security.test.ts`: normal-security Chrome through Vite and the real web
  client, including plugin execution, bot lifecycle and concurrent restart recovery.
- Existing HTTP/Telegram UI and thread HTTP/WS tests acquire a Human session while
  preserving their behavior and isolation assertions. CLI/MCP, package smoke,
  coverage, release, license and repository protection policies are not weakened.

Acceptance evidence must identify the exact commit and runtime. A passing helper
suite is not evidence that the complete Hivemind build, browser engine, package,
or both CI Node versions passed. Final PR notes record executed versus pending
validation and the explicit residual local-process/XSS/cookie-theft boundary.
