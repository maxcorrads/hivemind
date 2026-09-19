import { Transform } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { StringDecoder } from "node:string_decoder";

export const MAX_LOG_LINE = 64 * 1024;
export function redactText(text, secrets = []) {
  let safe = stripVTControlCharacters(text);
  for (const secret of secrets) if (secret.length >= 4) safe = safe.split(secret).join("[REDACTED]");
  return safe
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, "$1 [REDACTED]")
    .replace(/((?:set-cookie|cookie|authorization)\s*[=:]\s*).*/gi, "$1[REDACTED]")
    .replace(/(["']?(?:[\w-]*(?:token|secret|password|api[_-]?key)|credential)["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;&}]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED]");
}
// Hold whole lines, including across one-byte chunks. Oversized lines are
// discarded, never partially flushed. Private-key blocks may span lines.
export function createRedactor(secrets = []) {
  const decoder = new StringDecoder("utf8");
  let pending = "", dropping = false, key = false, markerTail = "";
  const trackDroppedKey = value => {
    const text = markerTail + value;
    for (const match of text.matchAll(/-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g)) key = match[1] === "BEGIN";
    markerTail = text.slice(-128);
  };
  const line = (stream, value) => {
    if (/-----BEGIN .*PRIVATE KEY-----/.test(value)) key = true;
    if (key) {
      stream.push("[REDACTED PRIVATE KEY]\n");
      if (/-----END .*PRIVATE KEY-----/.test(value)) key = false;
    } else stream.push(redactText(value, secrets) + "\n");
  };
  const consume = (stream, input) => {
    for (const part of input.split(/(\n)/)) {
      if (part === "\n") {
        if (!dropping) line(stream, pending);
        pending = ""; dropping = false; markerTail = "";
      } else if (dropping) trackDroppedKey(part);
      else {
        pending += part;
        if (pending.length > MAX_LOG_LINE) {
          trackDroppedKey(pending);
          pending = ""; dropping = true;
          stream.push("[OVERSIZED LOG LINE OMITTED]\n");
        }
      }
    }
  };
  return new Transform({
    transform(chunk, _encoding, done) { consume(this, decoder.write(chunk)); done(); },
    flush(done) { consume(this, decoder.end()); if (pending && !dropping) line(this, pending); done(); },
  });
}
