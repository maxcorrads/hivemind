/** A server origin without credentials, path or query; used to validate HIVEMIND_URL. */
export function identityOrigin(raw = process.env.HIVEMIND_URL ?? "http://127.0.0.1:7420"): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname))
    throw new Error("Expected a server origin without credentials, path or query");
  return url.origin;
}
export function currentToken(cliToken?: string): string | undefined {
  // An explicit shell token belongs to that shell. Never fall back to another
  // terminal's last join, even if its server/project happens to match.
  return cliToken || process.env.HIVEMIND_TOKEN || undefined;
}
