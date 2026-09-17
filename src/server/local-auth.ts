export function isLoopbackHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const url = new URL(`http://${hostHeader}`);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function isTrustedBrowserOrigin(
  origin: string | null | undefined,
  hostHeader: string | null | undefined,
): boolean {
  if (!origin || origin === "null" || !isLoopbackHost(hostHeader)) return false;
  try {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return false;
    const host = new URL(`http://${hostHeader}`);
    const samePort = url.port === host.port;
    const viteDev = url.port === "7421";
    return samePort || viteDev;
  } catch {
    return false;
  }
}

export function cookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function hasHumanSession(
  cookieHeader: string | null | undefined,
  expected: string,
  headerValue?: string | null,
): boolean {
  return cookieValue(cookieHeader, "hivemind_human") === expected || headerValue === expected;
}

export function humanSessionCookie(value: string): string {
  return `hivemind_human=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/`;
}
