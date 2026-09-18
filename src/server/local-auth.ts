import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

// Deliberately do not normalize credentials, paths, alternate numeric IP forms,
// trailing dots, or proxy headers into a trusted authority.
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?$/.test(host)) return false;
  try {
    return new URL(`http://${host}`).port !== "0";
  } catch {
    return false;
  }
}

export function isTrustedBrowserOrigin(origin: string | null | undefined, host: string | null | undefined): boolean {
  return isLoopbackHost(host) && origin === new URL(`http://${host}`).origin;
}

// Our generated base64url cookies never need percent decoding. In particular,
// a malformed escape must not throw (or leak a cookie through an error log).
export function cookieValue(header: string | undefined, name: string): string | null {
  let value: string | null = null;
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (value !== null) return null; // Reject duplicate-name cookie tossing.
    value = part.slice(separator + 1).trim();
  }
  return value;
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validPort(port: number | undefined): port is number {
  return port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535;
}

function requestPath(target: string): string | null {
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return null;
  try {
    // Decode conservatively before classifying the boundary. This can reject
    // a path the router would 404, but must never under-protect an encoded API.
    const decoded = decodeURIComponent(new URL(target, "http://local.invalid").pathname);
    if (decoded.startsWith("//") || decoded.includes("\\")) return null;
    return new URL(decoded, "http://local.invalid").pathname;
  } catch {
    return null;
  }
}

function isJson(headers: IncomingHttpHeaders): boolean {
  return single(headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export class LocalHumanAuth {
  // Process-lifetime capability: restart invalidates all previous sessions.
  // Kept private, never persisted, printed, returned as JSON, or used in a URL.
  readonly #secret = randomBytes(32).toString("base64url");

  cookieName(port: number): string {
    if (!validPort(port)) throw new RangeError("Invalid local session port");
    return `hivemind_human_${port}`;
  }

  sessionCookie(port: number): string {
    return `${this.cookieName(port)}=${this.#secret}; HttpOnly; SameSite=Strict; Path=/`;
  }

  hasSession(headers: IncomingHttpHeaders, port: number | undefined): boolean {
    if (!validPort(port)) return false;
    const matches = (value: string | null | undefined) =>
      typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) &&
      timingSafeEqual(Buffer.from(value), Buffer.from(this.#secret));
    return matches(cookieValue(single(headers.cookie), this.cookieName(port))) ||
      matches(single(headers["x-hivemind-human"]));
  }

  allowsWebSocket(req: IncomingMessage): boolean {
    const site = single(req.headers["sec-fetch-site"]);
    return req.url === "/ws" &&
      isTrustedBrowserOrigin(single(req.headers.origin), req.headers.host) &&
      (req.headers["sec-fetch-site"] === undefined || site === "same-origin") &&
      this.hasSession(req.headers, req.socket.localPort);
  }

  /** The HTTP ingress gate. Call before BOTH the Hono router and static UI. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const reject = (status: number, error: string, sessionRequired = false): false => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      // Only this pre-handler rejection is safe for a client mutation retry.
      if (sessionRequired) res.setHeader("X-Hivemind-Session-Required", "1");
      res.writeHead(status);
      res.end(JSON.stringify({ error }));
      req.resume();
      return false;
    };

    if (!isLoopbackHost(req.headers.host)) return reject(403, "Invalid local Host");
    const pathname = requestPath(req.url ?? "/");
    if (pathname === null) return reject(400, "Invalid request target");
    const origin = single(req.headers.origin);
    // Empty, duplicate, opaque/null and malformed Origin values all fail closed.
    if (req.headers.origin !== undefined && !isTrustedBrowserOrigin(origin, req.headers.host)) {
      return reject(403, "Untrusted Origin");
    }
    const site = single(req.headers["sec-fetch-site"]);
    const api = pathname === "/api" || pathname.startsWith("/api/") || pathname === "/ws";
    if (api && req.headers["sec-fetch-site"] !== undefined && site !== "same-origin" && site !== "none") {
      return reject(403, "Cross-origin browser request");
    }
    const method = req.method ?? "GET";
    const human = pathname === "/api/ui" || pathname.startsWith("/api/ui/") || pathname === "/ws";
    const agent = pathname === "/api/agent" || pathname.startsWith("/api/agent/");
    if (api) res.setHeader("Cache-Control", "no-store");

    // Preflight cannot reach a mutation. Only an exact same-origin preflight is
    // admitted; Vite preserves the original Host for both HTTP and WebSocket.
    if ((human || agent) && method === "OPTIONS") {
      if (!isTrustedBrowserOrigin(origin, req.headers.host)) return reject(403, "Trusted browser Origin required");
      res.writeHead(204);
      res.end();
      req.resume();
      return false;
    }

    if (pathname === "/api/ui/session") {
      if (method !== "POST") return reject(405, "Session bootstrap requires POST");
      if (!isTrustedBrowserOrigin(origin, req.headers.host)) return reject(403, "Trusted browser Origin required");
      if (!isJson(req.headers)) return reject(415, "Session bootstrap requires application/json");
      if (!validPort(req.socket.localPort)) return reject(503, "Local session unavailable");
      // Namespace by the actual backend listener, never a caller/proxy header.
      res.setHeader("Set-Cookie", this.sessionCookie(req.socket.localPort));
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      req.resume();
      return false;
    }

    if (human) {
      if (!this.hasSession(req.headers, req.socket.localPort)) return reject(401, "Human session required", true);
      const read = method === "GET" || method === "HEAD";
      const explicit = single(req.headers["x-hivemind-ui"]) === "1" ||
        this.hasSession({ "x-hivemind-human": req.headers["x-hivemind-human"] }, req.socket.localPort);
      // SameSite is not same-origin (ports share cookies). Missing Origin is
      // normal for images/GETs, but needs Fetch Metadata or a non-simple header.
      if (origin === undefined && site !== "same-origin" && !(read && site === "none") && !explicit) {
        return reject(403, "Browser context required");
      }
    }
    const mutation = method === "POST" || method === "PUT" || method === "PATCH";
    const binaryUpload = method === "POST" &&
      (pathname === "/api/ui/files" || pathname === "/api/agent/files");
    const browserAgent = agent && (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined);
    if ((human || browserAgent) && mutation && !binaryUpload && !isJson(req.headers)) {
      return reject(415, "JSON mutations require application/json");
    }
    // Native agent clients (no Origin/Fetch Metadata) retain bearer-token auth,
    // including join/resume. The health endpoint remains session-independent.
    return true;
  }
}
