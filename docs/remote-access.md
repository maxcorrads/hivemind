# Remote access (iPhone and iPad)

Hivemind Server.app can let paired iPhones and iPads use Hivemind on your Mac,
terminals included. It does this through a **remote gateway**: a TLS listener
inside Hivemind Server.app, **off by default**. The Node server does not
change. It still listens on `127.0.0.1` only, and the gateway talks to it as
one more local native Human client. See
[Local Human security boundary](local-human-security.md#remote-gateway).

> [!WARNING]
> **A paired device can run any command on your Mac, as you.** It gets the
> full Human UI and the terminals: it can start agents with commands of its
> choosing, type into every Hivemind tmux session and read its output. Turn
> remote access on only if you want that, pair only devices you own and lock
> with a passcode, and revoke a lost device at once from **Devices…**.

The iOS/iPadOS app is described in [iOS and iPadOS app](ios.md). This page
is the protocol and the threat model that the gateway and the app implement.
The shared contract is in `macos/Sources/HivemindKit`, listed under
[Contract](#contract); where this page and that code disagree, the code is
right and this page needs fixing.

```text
iPhone / iPad                         Mac
+------------------+   TLS 1.3,     +------------------------------------------+
| Hivemind (iOS)   |   pinned cert  | Hivemind Server.app                      |
|  WKWebView  -----+--------------->|  remote gateway :7443 (private nets only)|
|  BrokerClient ---+--- wss ------->|    | proxy (HTTP/1.1, /ws)                |
+------------------+                |    |   -> http://127.0.0.1:7420 (Node)   |
                                    |    | /_hivemind/broker                    |
                                    |    |   -> broker.sock (terminal broker)  |
                                    +------------------------------------------+
```

## Using it

On the Mac, in the Hivemind Server menu:

1. **Remote Access** turns the gateway on or off. Turning it on asks for
   confirmation first, with the warning above; while it is on, a status line
   at the top of the menu shows it. Turning it off stops the listeners and
   closes every connection; the devices stay paired for the next time.
2. **Pair a Device…** opens a window with a QR code, the Mac's addresses, the
   certificate fingerprint in short form and a 5-minute countdown, plus
   **Copy Pairing Link** and **New Code**. It closes by itself once a device
   has paired.
3. On the iPhone or iPad, open Hivemind and scan the code with the camera,
   or paste the pairing link. The app pins the certificate fingerprint the
   code carries, so it never needs to trust the network.
4. **Devices (N)…** lists every paired device with the time it was last seen,
   and **Revoke…** removes one. Revoking closes that device's connections at
   once. The window also shows this Mac's fingerprint.
5. **Remote Access Settings** holds **Port…** (default `7443`), **Show Remote
   Access Log** and **Reset Identity…** (a new certificate, which revokes
   every device).

After a port change, a device on the same network finds the new port through
Bonjour, still pinned to the Mac's fingerprint, and saves it: from then on it
uses the new port on every saved address, Tailscale ones included. A device
that only ever reaches the Mac over a VPN, where Bonjour does not reach, learns
the new port the next time it is on the Mac's network, or pairs again.

### What you see on the Mac

- The first time the gateway listens, the macOS **Firewall** (when it is on)
  may ask whether Hivemind Server may accept incoming connections, and macOS
  15 and later may ask for **Local Network** access. Allow both, or devices
  cannot connect.
- Hivemind Server is signed ad hoc, not with a developer identity, so macOS
  ties its Keychain items to the exact build. After each update, macOS asks
  once whether the new build may use the "Hivemind Server remote access" key;
  choose **Always Allow**.
- If a listener cannot start (the port is taken, an address went away), the
  gateway tries again every 30 seconds and says so in the log.

| What | Where |
| --- | --- |
| On/off and port | `remoteAccess` and `remoteAccessPort` in Hivemind Server's UserDefaults (`GatewaySettings`) |
| Identity | The login Keychain: a P-256 key and a self-signed certificate, both labelled "Hivemind Server remote access" |
| Paired devices | `~/Library/Application Support/Hivemind/devices.json` (`0600`), [below](#devices-and-revocation) |
| Log | `~/Library/Logs/Hivemind/gateway.log` (**Show Remote Access Log**): connections refused, pairings, revocations, upstream errors; never a secret |

The device needs to reach the Mac on a private network: the same Wi-Fi or
wired LAN, or a VPN that hands out private addresses (Tailscale, Headscale,
WireGuard). See [Network scope](#network-scope).

## Threat model

**A paired device has everything a person at the Mac has.** That includes
terminals: it can start sessions that run commands, type into any Hivemind
tmux session and read its output. Pairing a device is therefore **remote
command execution on your Mac, as you**. This is a deliberate choice, so
every device gets the `human` and `terminals` permissions
(`DevicePermissions.all`); there is no read-only or chat-only device yet.
Pair only devices you own and protect with a passcode, and revoke a lost one
from **Devices (N)…** at once.

The trust boundary therefore moves: on the Mac alone it is "can reach
`127.0.0.1`" ([Local Human security boundary](local-human-security.md)); with
remote access on it is also "holds a device token". Everything below is about
keeping that token, and the sessions made from it, to the devices you paired.

What the gateway defends against:

| Attacker | What stops them |
| --- | --- |
| Someone on the same Wi-Fi or tailnet without a paired device | They cannot pair without a code that is valid for 5 minutes, used once and shown only on the Mac's screen. Without a device token they get no session. Every endpoint is rate-limited. |
| A man in the middle on the local network (ARP or DNS spoofing, a rogue access point) | The device pins the SHA-256 of the gateway's certificate, taken from the QR code, which never crosses the network. A different certificate fails before any secret is sent. |
| The public internet, a port forward, Tailscale Funnel | The gateway listens only on private addresses and refuses a connection unless both its local and its remote address are private. A forwarded port shows a public remote address. Funnel arrives over loopback. Both are refused. |
| A web page in a browser on the network (CSRF, DNS rebinding) | `Host` must name the gateway, `Origin` (when present) must be the gateway's origin, and cookies are `__Host-`, `SameSite=Strict` and `HttpOnly`. The gateway endpoints refuse any request that carries an `Origin`. |
| A stolen device-session cookie | It lasts 1 hour, is sent only to the exact gateway origin, and dies when the device is revoked. |
| A copy of `devices.json` | It holds only SHA-256 hashes of 256-bit tokens, which cannot be reversed. |
| A paired device that must stop working | Revoking it deletes its record, drops its sessions and closes its live connections (HTTP, `/ws`, broker). |
| A process that took the Node server's loopback port (another user, a sandboxed app, anything that got there while Hivemind was not bound) | The gateway forwards only to a server that answers the instance challenge with the secret Hivemind Server.app started it with ([Verified server](#verified-server)). Anything else gets no request, no Human capability and no terminals, and devices get `503 server-unverified`. |

What the gateway does **not** defend against:

- **A lost, unlocked device.** Whoever holds the unlocked device is you, as far
  as the gateway can tell. The token sits in the iOS Keychain, readable only
  after first unlock and never synced. There is no second factor or app lock
  for now.
- **Anyone who sees the QR code while it is valid.** It is the pairing secret.
  A photo or screen share of it lets another device pair within 5 minutes.
  The **Devices…** list shows every device that paired.
- **Other devices on your tailnet or LAN reaching the port.** They can connect
  and try. Without a token they cannot do anything, but the gateway is
  reachable to them.
- **Compromise of the page.** An XSS in the web UI, or a compromised Node
  server, controls the page on the device just as it would on the Mac,
  terminals included (see [macOS apps: Security note](macos.md#security-note)).
  The gateway does not make the page more trusted than it is on the Mac. The
  page never holds the device token, the device-session cookie (HttpOnly) or
  the Human capability, so it cannot carry any of them off the device, but
  while it runs it can do anything the Human can.
- **A compromised Mac account.** Anything running as you on the Mac can read
  `devices.json`, may get at the gateway's Keychain identity, or can just use
  the local server and broker directly, as before.
- **Local processes on the Mac.** They can reach the Node server directly, as
  before. The gateway refuses loopback connections, so it gives them nothing
  new. A process that races the real server for its port between the moment
  that server dies and the moment Hivemind Server.app notices could get the
  requests already in flight; a new request or WebSocket after that is checked
  against the new server first.

## Network scope

Private means one of these (`AddressScope`, `RemoteAddressPolicy`):

| Scope | Range |
| --- | --- |
| RFC 1918 | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` |
| Shared address space (Tailscale, Headscale) | `100.64.0.0/10` |
| IPv6 unique local | `fd00::/8` (the reserved `fc00::/8` half is not private) |
| Link-local | `169.254.0.0/16`, `fe80::/10` |

Loopback (`127.0.0.0/8`, `::1`) is **not** allowed. IPv4-mapped IPv6 addresses
are judged by the IPv4 address inside. There is no dependency on Tailscale:
any VPN that hands out addresses in these ranges works.

- The gateway listens only on the private addresses of the Mac's interfaces
  (`RemoteAddressPolicy.listenAddresses`). It follows interface changes.
- Every accepted connection is checked again with
  `RemoteAddressPolicy.accepts(local:remote:)` and closed at once unless both
  ends are private.
- It advertises Bonjour `_hivemind._tcp`, with TXT keys `v` (protocol
  version), `fp` (the certificate fingerprint, 64 lowercase hex) and `name`
  (the Mac's name) (`GatewayAdvertisement`). A device uses the TXT record only
  to find a Mac it has **already paired** with after that Mac's address
  changed, by matching `fp` against its pin (`PairedMac.isAdvertised(by:)`).
  It is never trusted for pairing, because anyone can advertise one.
- Default port **7443** (`GatewayLimits.defaultPort`), set in the menu.

## TLS and pinning

- On first use, Hivemind Server.app creates a self-signed identity (ECDSA
  P-256) and keeps it in the login Keychain. The private key never leaves it.
- The gateway speaks TLS 1.3 only. Both ends are Hivemind, so no older
  version is needed.
- The **fingerprint** is the SHA-256 of the certificate's DER bytes
  (`CertificateFingerprint`). The QR code and TXT record carry it as 64
  lowercase hex characters. People see it as `AB:CD:…` (`display`), or in the
  short form `AB:CD:EF:01…23:45:67:89` for comparing both screens.
- The device accepts a server only when the leaf certificate it presents
  hashes to the pinned fingerprint (`matches(certificateDER:)`). It skips the
  system trust evaluation: there is no CA, and the certificate's name and
  expiry do not matter. The same check guards the web view's navigation
  delegate, every native `URLSession` call and the broker WebSocket.
- A new identity (reset from the menu) changes the fingerprint. Every device
  must then pair again. Resetting it also revokes every device.
- App Transport Security does not apply to IP-literal hosts.
  `NSAllowsLocalNetworking` covers `.local` names. The app allows no other
  exception.

## Secrets

All secrets come from the OS CSPRNG (`SystemRandomNumberGenerator`) and are
written as unpadded base64url (`GatewaySecrets.swift`):

| Secret | Size | Lives | Stored as |
| --- | --- | --- | --- |
| `PairingCode` | 128 bits (22 chars) | 5 minutes, single use, in the QR code | memory only (the Mac) |
| `DeviceToken` | 256 bits (43 chars) | until revoked | the device's Keychain; the Mac keeps `SHA256(token)` in `devices.json` |
| `DeviceSessionToken` | 256 bits (43 chars) | 1 hour | a cookie on the device; the Mac keeps `SHA256(token)` in memory |

Every secret has at least 128 random bits, so there is nothing to brute-force,
and a plain SHA-256 (`SecretHash`) is the right way to store one: no salt, no
slow KDF. All comparisons are constant-time (`ConstantTime`). A lookup checks
every record and does not stop early (`DeviceRegistry.device(tokenHash:)`).
Secrets never appear in logs, and their `description` hides them.

SHA-256 comes from CryptoKit where it exists: it is an Apple system framework
on every platform HivemindKit builds for. A portable implementation
(`PortableSHA256`) is always compiled and tested against the same vectors,
so HivemindKit does not depend on CryptoKit to build.

## Protocol

`GatewayProtocol.version` = **1**. Every gateway JSON reply carries `"v": 1`.
Errors look like this:

```json
{ "v": 1, "error": "invalid-code", "message": "…" }
```

The codes are in `GatewayErrorCode`, each with its HTTP status. A client reads
any code it does not know as `internal`.

| Code | Status | When |
| --- | --- | --- |
| `bad-request` | 400 | Malformed JSON, wrong media type, a field out of range, a malformed request |
| `unauthorized` | 401 | No live device session: missing, expired, or forgotten because Hivemind Server restarted. Sent with `X-Hivemind-Device-Session: required`. The app gets a new session with its device token, without asking |
| `device-revoked` | 401 | `POST /_hivemind/session` with a device token the Mac does not know: the device was revoked, or the Mac's identity was reset. The only answer that makes the app close the Mac's windows and offer to pair again |
| `invalid-code`, `pairing-closed`, `forbidden-origin` | 403 | Pairing refused; an `Origin` that is not allowed |
| `not-found` | 404 | An unknown `/_hivemind/` path |
| `too-many-devices` | 409 | 32 devices paired |
| `length-required` | 411 | A `/_hivemind/` POST without a `Content-Length` (chunked, or none at all); the connection closes after it |
| `too-large` | 413 | A head or body over its limit |
| `pairing-locked` | 423 | Too many wrong codes |
| `rate-limited` | 429 | Too many attempts from this address |
| `internal` | 500 | Anything else |
| `server-unavailable` | 502 | The Node server (or the broker) is not running or did not answer |
| `server-unverified` | 503 | Something answers on the Node server's port that could not prove it is the server Hivemind Server.app started ([Verified server](#verified-server)) |

The gateway answers everything under `/_hivemind/` itself
(`GatewayPath.isGatewayOwned`). It never proxies those paths; an unknown one
gets `not-found`. **The gateway endpoints refuse any request that carries an
`Origin` header** (`forbidden-origin`). Only native code (URLSession) calls
them, never the page. The page reaches terminals only through the bridge, as on
the Mac.

### Pairing

1. On the Mac, **Pair a Device…** opens a window. It shows a QR code and
   the fingerprint in short form, and counts down 5 minutes. Only one pairing
   window is open at a time. Closing it, or letting it expire, discards the
   code.
2. The QR code holds a pairing link (`PairingPayload`):

   ```text
   hivemind-pair://pair?v=1&name=Studio%20Mac&host=192.168.1.20&host=100.101.102.103
     &port=7443&fp=<64 lowercase hex>&code=<22 base64url>
   ```

   - `host` repeats, 1 to 8 times, in the order to try: LAN first, then
     tailnet, then IPv6 ULA (`RemoteAddressPolicy.pairingHosts`). Every host
     is a private IP literal. IPv6 link-local is never listed, because its
     zone means nothing on another device.
   - The other keys appear exactly once. Unknown keys are ignored. A `v`
     higher than the app knows is refused with "update the app". The whole
     link is at most 1 KiB.
   - A person can paste the same link instead of scanning it.
3. The device connects to the first host that answers, pinning `fp`, and
   sends:

   ```http
   POST /_hivemind/pair
   Content-Type: application/json

   {"code":"…","deviceName":"Anna's iPhone","platform":"ios"}
   ```

   `platform` is `ios` or `ipados`. `deviceName` is trimmed and must be 1 to
   64 characters, with no control or invisible format characters
   (`PairRequest.validated()`, `DeviceName`). The request must carry exactly
   one `Content-Type: application/json` (`bad-request` otherwise) and a body
   of at most 4 KiB (`too-large`, 413) with a `Content-Length`. A chunked body,
   or one without any length, gets `length-required` (411), and the gateway
   closes the connection after that answer, since it cannot tell where such a
   body ends without reading all of it.
4. The gateway checks, in this order:
   - the rate limit for the remote address (10 attempts per minute),
   - whether a pairing window is open (`pairing-closed`),
   - whether the code matches, in constant time and within its lifetime
     (`invalid-code` for wrong, used and expired alike).

   After 5 wrong codes the window locks (`pairing-locked`) and the code is
   discarded. With 32 devices paired the answer is `too-many-devices`. On
   success the code is used up at once, a `DeviceRecord` is saved, and the
   window shows "Paired with Anna's iPhone" and closes:

   ```json
   {"v":1,"deviceId":"<uuid>","token":"<43 base64url>","name":"Studio Mac"}
   ```

5. The device stores the token in its Keychain under `deviceId`, with
   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and not synchronizable.
   It keeps the rest as a `PairedMac`.

### Device sessions

```http
POST /_hivemind/session
Authorization: Bearer <device token>
Content-Type: application/json
Content-Length: 2

{}
```

- The gateway reads nothing from the body, which the app sends as `{}` so that
  URLSession always sends a `Content-Length`; an empty body needs
  `Content-Length: 0`, and none at all is `length-required`, as for pairing.
  There is no `Origin`, and the rate limit is 30 attempts per address per
  minute.
- The gateway hashes the token and looks it up. It answers `device-revoked`
  for an unknown or revoked token.
- On success it creates a `DeviceSessionToken`, updates the device's
  `lastSeenAt`, and replies:

  ```http
  Set-Cookie: __Host-hivemind-device=<token>; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict
  ```

  ```json
  {"v":1,"cookieName":"__Host-hivemind-device","cookieValue":"<token>","expiresAt":<unix ms>,"home":"/Users/you"}
  ```

  `home` (optional) is the Mac user's home folder. The device needs it to
  turn a launch folder of `~` or `~/…`, or none, into the absolute folder the
  broker takes, as Hivemind.app does on the Mac. A paired device can read
  any file as you through a terminal anyway, so this tells it nothing new.
  Without `home`, the app refuses such launches with a message instead of
  guessing.

- The app puts that cookie into the web view's `WKHTTPCookieStore` before
  loading `https://<host>:<port>/`, on the host that issued it (the cookie is
  bound to that exact origin). The call itself goes over an ephemeral
  URLSession without a cookie store, so the cookie lives nowhere else.
- The app counts the session's hour on its own clock from the moment it asked
  (or the Mac's `expiresAt`, if that is sooner), so a Mac and a device whose
  clocks differ cannot break sessions.
- Sessions are **renewed silently** with the long-lived device token: when
  less than 30 minutes are left (`GatewayLimits.sessionRenewBefore`), and
  when a scene becomes active and the session is more than 60 seconds old, so
  several iPad windows coming forward together do not each make one. A
  device holds at most 8 live sessions; the oldest one goes first. The person
  never sees a session expire.
- **Reopening after days works without pairing again.** When a scene comes
  forward (the app opened again, or brought back after iOS suspended it) and
  the session it had has run out meanwhile, the app first gets a new session
  with the device token, puts its cookie into the web view, and only then
  loads the page again (`RemoteSessionKeeper.isExpired(at:)`,
  `SceneController.sceneDidBecomeActive`). Only a revoked device (or a reset
  identity) has to pair again.
- A `device-revoked` reply from `/session` means the Mac revoked the device
  (or its identity was reset). The app then closes that Mac's windows with
  "This device was removed from <Mac>. Pair again". For an older gateway, an
  `unauthorized` reply from `/session` means the same. Nothing else makes the
  app give up on a pairing.
- Hivemind Server keeps sessions in memory only. After it restarts (or remote
  access is turned off and on), the gateway answers the device's requests
  `unauthorized` with `X-Hivemind-Device-Session: required`. The app gets a
  new session at once, whoever notices first: the page (which cannot renew it
  itself, since it never holds the device token) posts the bridge message
  `device-session-expired`; the broker WebSocket gets a `401` on its upgrade;
  the main document gets a `401`. Reports from every window and page of one
  Mac within 5 seconds share one renewal
  (`RemoteSessionKeeper.pageReportedExpiry()`). The page's own retries (its
  `/ws` reconnect) then find the new cookie; see
  [Reconnecting](#reconnecting).

### Proxy

Every request that is not a gateway endpoint goes to the Node server. Only
these requests are forwarded:

- The request carries a valid device session (the `__Host-hivemind-device`
  cookie, `DeviceSessionCookie.token(fromCookieHeader:)`). Without one the
  gateway answers `unauthorized`.
- `Host` names the gateway: the local address the connection arrived on, or
  the Mac's `.local` name, with the gateway port. This stops DNS rebinding.
- `Origin`, when present, is exactly the gateway origin
  (`GatewayEndpoint.origin`, for example `https://192.168.1.20:7443`).
  Otherwise the gateway answers `forbidden-origin`. A request with more than
  one `Host` or `Origin` is refused.
- The target is origin-form (`/…`). `CONNECT`, `TRACE` and absolute-form
  targets are refused.

The gateway forwards to `http://127.0.0.1:<server port>` and to nothing else.
It uses the port of the server Hivemind Server.app runs. There is no
configurable upstream, and the path cannot pick one. It rewrites the request:

| Header | To the Node server |
| --- | --- |
| `Host` | `127.0.0.1:<server port>` |
| `Origin` (if present) | `http://127.0.0.1:<server port>` |
| `Cookie` | removed entirely: the device cookie never reaches Node, and no `hivemind_human_*` cookie comes from the device |
| `X-Hivemind-Human` | removed if the device sent one, then set to the gateway's own Human capability |
| `Referer` | removed |
| `Forwarded`, `X-Forwarded-*`, `X-Real-IP` | removed (Node ignores them anyway) |
| `Expect` | removed; the gateway answers `100-continue` itself |
| Hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-*`, `TE`, `Trailer`, `Upgrade` except on `/ws`) | removed. The body is re-framed as the gateway streams it. |
| Everything else, `Sec-Fetch-*` included | passed on unchanged |

It also rewrites the response:

| Header | To the device |
| --- | --- |
| `Set-Cookie` | **every one removed**, so the device never holds the Human capability, even from `POST /api/ui/session` |
| `Location` pointing at `http://127.0.0.1:<port>` | rewritten to the gateway origin; anything else passed on |
| Hop-by-hop headers | removed |
| Everything else (`Cache-Control`, `X-Frame-Options`, CSP…) | passed on |

The **Human capability**: once the server is [verified](#verified-server),
the gateway bootstraps it like any native local client. It sends `POST /api/ui/session` with `Origin: http://127.0.0.1:<port>`
and `Content-Type: application/json`, reads the `hivemind_human_<port>` value
from `Set-Cookie`, and keeps it in memory. It sends that value as
`X-Hivemind-Human` on every proxied request (see
[Server policy](local-human-security.md#server-policy)). Concurrent requests
share one bootstrap; if it takes more than 10 seconds they get
`server-unavailable`. When the Node server answers `401` with
`X-Hivemind-Session-Required: 1`, for example after a restart, the gateway
drops that capability and passes the `401` on. It does not bootstrap at once:
the next request verifies the server again and bootstraps, so the page's own
bootstrap-and-replay succeeds against the fresh capability. The page's `POST /api/ui/session` is proxied
like any request; its `Set-Cookie` is removed, and the page never needs it.

Each proxied request gets a fresh loopback connection that closes after its
answer (`Connection: close` to Node), while the device's own connection is
kept alive between requests. The gateway reads the HTTP/1.1 it relays
strictly (`GatewayHTTP.swift`), so two parsers cannot disagree about where a
request ends (request smuggling): a request with two `Content-Length`s, or a
length together with `Transfer-Encoding`, or any coding other than
`chunked`, is refused. It answers `Expect: 100-continue` itself; a `HEAD`,
`204` or `304` answer keeps the server's `Content-Length`. A response head
may be at most 64 KiB.

Bodies are streamed both ways and never buffered whole, with flow control in
both directions: a slow device slows the reading of the server and the other
way round. A request body is limited to 513 MiB (the server's 512 MiB file
limit plus room for multipart framing), and a response body to 1 GiB. When
the server answers before the request body has ended (a refusal, say), the
gateway reads and drops the rest, up to 1 MiB, to keep the connection;
beyond that it closes it. `/ws` is an upgrade with the same
checks, where `Origin` is required. After the `101` the gateway splices bytes
both ways until either side closes, or until the device is revoked or remote
access is turned off. If the Node server is not running, the reply is
`server-unavailable` (502); if it cannot be verified, `server-unverified`
(503).

Every answer the gateway sends while it holds a request back (waiting for the
server's check or the Human bootstrap, or after the server closed without
answering) leaves a kept-alive device connection being read again, so the
device's next request on it is served; any other way out closes the
connection.

### Verified server

Anything can listen on the Node server's loopback port while Hivemind is not
bound there (not started yet, restarting, crashed): another macOS user, or a
sandboxed app that cannot read your files. The gateway would hand it the
devices' requests and its pages would reach the Mac's terminals. So the gateway
checks the server exactly as Hivemind.app does before it gives a page
terminals ([Verifying the server](macos.md#verifying-the-server)):

1. Hivemind Server.app starts every server with a fresh 256-bit secret. The
   gateway runs in the same app and takes that secret from memory
   (`ServerAppController.instanceSecret`); only if that is ever missing does
   it read it from the `0600` discovery file written for the same process
   (the same pid and port). Nothing else is trusted, and the secret is never
   logged.
2. It sends a fresh nonce to `GET /api/health/instance?nonce=<64 hex>` on
   `http://127.0.0.1:<port>` and checks the HMAC proof in constant time
   (`InstanceVerifier`, `InstanceServerVerifier`, `GatewayServerTrust.swift`).
3. It checks **before its Human bootstrap and on every (re)connection to the
   server**: the first request after Hivemind Server.app (re)started it (a new
   secret, or a new port), after a loopback connection to it failed or closed
   without an answer, after it asked for a new Human session, and on every
   WebSocket upgrade (`/ws` and `/_hivemind/broker`, which is how pages and
   terminals reconnect). Requests in between on the same verified server are
   forwarded without another check. Concurrent requests share one check, which
   may take 10 seconds.
4. The outcome:
   - **Verified**: forwarded as described above.
   - **Nothing answered** (stopped, restarting): `server-unavailable` (502),
     and the next request checks again.
   - **Anything else** (no proof, a wrong one, `404` because the process has no
     secret, another status): `server-unverified` (503). The gateway forwards
     nothing: no request, no Human capability (it drops the one it had), no
     `/ws`, and it closes every connection already forwarding (proxied
     requests, `/ws`, terminals). It logs why, and refuses every request for
     5 seconds before it checks again, so a flood of requests is not a flood
     of checks.

**Terminals follow the same rule** as in Hivemind.app, where a page gets
terminals only from a verified server (`TerminalTrustGate`): the gateway
bridges `/_hivemind/broker` only while the server is verified (checked afresh
on each upgrade), answers `server-unverified` or `server-unavailable`
otherwise, and closes the bridges when a check fails. The broker itself is
Hivemind Server.app's own, reached through its `0600` socket with the token
read from `broker.token` like Hivemind.app does; a broker connection that is
already open is not closed because the Node server merely stopped or
restarted, only when something unverified answers in its place.

The app shows a `server-unverified` answer on its connection screen:
"Hivemind on <Mac> couldn't be verified", with **Try Again**.

### Terminal broker

`GET /_hivemind/broker` is a WebSocket upgrade. It requires a device session
cookie, a [verified](#verified-server) server, and no `Origin`: the app's `URLSessionWebSocketTask` sets `Cookie`
itself and sends no Origin. The gateway bridges it to the local broker socket
(`broker.sock`) and speaks the same protocol there
([Terminal broker](terminal-broker.md#protocol)):

- Each WebSocket **text** message carries exactly one broker frame, with or
  without its trailing newline (`BrokerWebSocketFraming`). A binary message,
  an empty one or one with two frames closes the connection.
- The limits are 1 MiB per message from the device and 4 MiB to the device
  (`GatewayLimits.maxBrokerMessageInBytes` / `OutBytes`). The app sets
  `maximumMessageSize` to at least 4 MiB.
- The first frame must be `hello`. The device sends the fixed placeholder
  token `GatewayBrokerHello.deviceToken` (64 zeros). The gateway replaces it
  with the real broker token it read from `broker.token`, and sets `client`
  to `device:<platform>:<name>` (`GatewayBrokerHello.rewrite`). No device
  ever sees the broker token. Any other first frame gets a broker `error`
  frame with code `unauthorized`, then the WebSocket closes with 1008.
  Later frames pass through unchanged, and the broker checks every one as it
  always does.
- Flow control: while the device does not read (`setReceiving(false)`), TCP
  pushes back to the gateway. The gateway then stops reading the broker, and
  the broker's own backpressure pauses the PTYs.
- There are at most 8 broker connections per device, and the broker's own
  limit of 32 connections still applies.

On the device, `WebSocketBrokerConnector` makes a `WebSocketChannel` (the
app's URLSession WebSocket with pinning and the cookie, `RemoteWebSocketChannel`)
look like the byte stream `BrokerClient` speaks. The app reuses `BrokerClient`
and `TerminalBridgeRouter` unchanged, over the same bridge messages as the Mac
app ([Terminal broker: Bridge](terminal-broker.md#bridge-hivemindapp--page)),
with these differences (`RemoteTerminalPolicy`, `RemoteClientBridge`):

- The app tells the page its platform: `platform: "ios"` in every
  `terminal-status`, and a `hivemind:native` event
  `{command: "ready", platform: "ios"}` in answer to the page's `ready`.
  Hivemind.app on the Mac sends neither, and the page reads that as `macos`.
- There is no Terminal.app on the device. The page does not offer **Open in
  Terminal** there; the Launch sheet's button is **Start on Mac**, which
  starts the session on the Mac and then shows its in-app terminal. The app
  sends every launch with `openInTerminal: false` and answers `terminal-open`
  with an error, whatever the page asks.
- The page does not offer **Start Hivemind Server** there: a device cannot
  start the Mac's server. It says "Terminals need Hivemind Server running on
  your Mac" instead, and "Install tmux on your Mac" when tmux is missing.
- The in-app terminal always shows its row of Esc, Ctrl, Tab, ^C and arrow
  keys, even on an iPad with a keyboard or trackpad, whose keyboards may lack
  Esc.

## Reconnecting

Whatever breaks the connection for a moment, the app and the page put it back
by themselves, and every open terminal shows the same tmux session again, as
if nothing had happened:

| What happened | What recovers it |
| --- | --- |
| The device session is about to expire | Renewed ahead of time; nothing is closed. A session that expires does not close the `/ws` or terminal WebSockets opened with it |
| The app was away longer than a session lasts | The session is renewed with the device token first, then the page loads again ([Device sessions](#device-sessions)) |
| Hivemind Server.app (and with it the gateway) restarted, or remote access was turned off and on | The gateway forgot the session: the first `401` with `X-Hivemind-Device-Session: required` makes the app renew it; the page's `/ws` retries then find the new cookie |
| The Node server restarted | The gateway checks the new server and bootstraps a new Human capability; the page reconnects `/ws` as it does in a browser. Terminals are not affected |
| A network blip, the Mac asleep for a while | The page's `/ws` retries with backoff; `BrokerClient` retries the broker WebSocket forever (0.5 s, 1 s, 2 s, 4 s, then every 5 s) |

When the broker connection comes back, the page attaches every terminal view
it still shows to the **same** tmux session again, with the size it has now;
tmux redraws the screen on attach. While it waits, the terminal keeps what it
showed under a "Reconnecting…" note. Only a session that really ended (the
broker lists it no longer running, or refuses the attach with
`no-such-session`) shows "Session ended". Hivemind.app on the Mac does the same
for its local broker ([Terminal broker: Clients](terminal-broker.md#clients)).

The one thing that is not recovered is revocation: `device-revoked` closes the
Mac's windows on the device and shows "This device was removed from <Mac>.
Pair again".

## Devices and revocation

`~/Library/Application Support/Hivemind/devices.json` (`0600`,
`HivemindPaths.gatewayDevices`, `DeviceRegistry`) holds one `DeviceRecord` per
device: `id`, `name`, `platform`, `tokenHash`, `createdAt`, `lastSeenAt` and
`permissions`. It has no secret in it. There are at most 32 devices.

**Devices (N)…** lists them with their last-seen time. **Revoke…** removes the
record, forgets the device's sessions and closes every connection the device
has open. Turning **Remote Access** off stops the listeners and closes every
connection; the devices stay paired for the next time it is turned on.
**Reset Identity…** makes a new certificate and revokes every device.

A session that merely expires does not close connections that are already
open: a `/ws` or terminal WebSocket opened with it keeps running until it
closes, the device is revoked or remote access is turned off. Every new
request and every new WebSocket needs a live session.

## Limits

`GatewayLimits` is the authority. The main values:

| Limit | Value |
| --- | --- |
| Pairing code lifetime | 5 min |
| Wrong codes before the window locks | 5 |
| Pairing attempts per address | 10 / min |
| Session attempts per address | 30 / min |
| Session lifetime / renew when less than | 1 h / 30 min |
| Devices | 32 |
| Connections (all / per address) | 128 / 48 |
| TLS handshakes in flight / time for one | 32 / 15 s |
| Sessions per device | 8 |
| Broker connections per device | 8 |
| Human bootstrap | 10 s |
| Server instance check / refused after a failed one | 10 s / 5 s |
| Session renewals for "the gateway forgot it" reports, per Mac | 1 per 5 s |
| Request head | 32 KiB, 100 headers, 15 s to arrive |
| Response head from Node | 64 KiB |
| Refused body read and dropped | up to 1 MiB |
| Gateway endpoint bodies | 4 KiB |
| Proxied request / response body | 513 MiB / 1 GiB |
| Idle keep-alive | 120 s |
| Broker message in / out | 1 MiB / 4 MiB |

## Contract

| File (`macos/Sources/HivemindKit`) | What it holds |
| --- | --- |
| `GatewayAddress.swift` | `IPAddress` (strict parsing, canonical text), `AddressScope`, `RemoteAddressPolicy`, `InterfaceAddress` |
| `GatewaySecrets.swift` | `PairingCode`, `DeviceToken`, `DeviceSessionToken`, `SecretHash`, `Base64URL` |
| `SHA256.swift` | `SHA256Hash`, `PortableSHA256`, `Hex`, `ConstantTime` |
| `GatewayFingerprint.swift` | `CertificateFingerprint` |
| `GatewayProtocol.swift` | `GatewayProtocol`, `GatewayPath`, `GatewayHeader`, `DeviceSessionCookie`, `GatewayEndpoint`, `PairRequest` / `PairResponse` / `SessionResponse`, `GatewayError(Code)`, `DeviceName`, `DevicePlatform`, `GatewayAdvertisement` |
| `PairingPayload.swift` | `PairingPayload` (the `hivemind-pair://` link) |
| `PairedMac.swift` | What the iOS app keeps per Mac |
| `DeviceRecord.swift` | `DeviceRecord`, `DevicePermissions`, `DeviceRegistry` |
| `GatewayLimits.swift` | Every limit above |
| `GatewayBrokerTransport.swift` | `WebSocketChannel`, `WebSocketBrokerConnector`, `BrokerWebSocketFraming`, `GatewayBrokerHello` |
| `GatewayHTTP.swift` | The strict HTTP/1.1 heads, framing and chunked bodies the gateway speaks (anything two parsers could read differently is refused) |
| `GatewayPolicy.swift` | Routing a request from its head: `Host`, `Origin`, method, target and upgrades (`GatewayRoute`) |
| `GatewayRewrite.swift` | The header rewrites to and from the Node server, and the gateway's `HumanCapability` |
| `GatewayState.swift` | The pairing window, device sessions and rate limits (`GatewayRateLimiter`, `GatewayPairing`, `GatewaySessionStore`) |
| `GatewayWebSocket.swift` | The WebSocket handshake and frames for `/_hivemind/broker` |
| `GatewayServer.swift`, `GatewayConnection.swift`, `GatewayBrokerBridge.swift` | The gateway itself: connections, pairing and sessions, the Human capability, the proxy state machine and the broker bridge, over `GatewayStream` (`GatewayTransport.swift`) |
| `GatewayServerTrust.swift` | The server the gateway forwards to (`GatewayUpstreamServer`: port and instance secret), its verification (`GatewayServerVerifying`, `InstanceServerVerifier` over `InstanceVerifier`) and what the gateway knows about it (`GatewayServerTrust`) |
| `GatewaySettings.swift`, `GatewayCertificate.swift` | The on/off and port settings, and the self-signed certificate the app signs with its Keychain key |
| `RemoteClientHTTP.swift`, `RemoteClientSession.swift`, `RemoteClientStore.swift`, `RemoteClientWebSocket.swift`, `RemoteClientDiscovery.swift`, `RemoteClientWindow.swift` | The iOS app's side: pairing and session calls, session renewal, saved Macs, the broker WebSocket, Bonjour matching, and the per-scene navigation, bridge and terminal rules |

Everything there is Foundation-only (plus CryptoKit when it is available) and
builds for macOS and iOS. The unit tests use fakes and never open a socket:
`swift test --package-path macos`. The page's side is `web/native-bridge.ts`
(`NativePlatform`) and `web/use-terminal.ts`. The live pieces (the
Network.framework listener, the Keychain identity, the menu) are in
`macos/Sources/HivemindServerApp`, and the iOS app in `ios/`.

## Not included

- **Push notifications (APNs).** They need an Apple developer account, an App
  ID with the push entitlement and a push provider on the Mac, and are planned
  for a later change. Until then notices reach the device only while the app
  runs: as in-app banners while it is in front, and as notifications for the
  short time iOS lets it run in the background; see
  [iOS and iPadOS app](ios.md#notifications).
- **Access from outside private networks.** Use a VPN that gives private
  addresses (Tailscale, Headscale, WireGuard).
- **Per-device permissions other than "all".** The field exists; the UI does
  not offer anything else yet.
- **Starting Hivemind Server from the device.** If the server is stopped, the
  device shows the error and a retry.
- **Throughput tuning.** The gateway relays on the main queue of Hivemind
  Server.app, which is plenty for the UI and terminals but may cap very large
  downloads.
