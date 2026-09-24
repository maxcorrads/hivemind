import type { ReactNode } from "react";

/** Parsed bodies by text, newest last: a re-rendered row reuses its parse instead of rescanning up to 20k chars. */
const parsed = new Map<string, ReactNode[]>();
const PARSED_BODIES = 1000;

export function renderBody(body: string): ReactNode[] {
  const cached = parsed.get(body);
  if (cached) {
    parsed.delete(body);
    parsed.set(body, cached);
    return cached;
  }
  const parts = parseBody(body);
  parsed.set(body, parts);
  if (parsed.size > PARSED_BODIES) parsed.delete(parsed.keys().next().value!);
  return parts;
}

function parseBody(body: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /```(\w+)?\n([\s\S]*?)```|`([^`]+)`|\*\*([^*]+)\*\*|@([A-Za-z][A-Za-z0-9_-]*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(body))) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    if (m[2] != null) {
      parts.push(
        <pre key={key++}>
          <code>{m[2]}</code>
        </pre>,
      );
    } else if (m[3] != null) {
      parts.push(<code key={key++}>{m[3]}</code>);
    } else if (m[4] != null) {
      parts.push(<strong key={key++}>{m[4]}</strong>);
    } else if (m[5] != null) {
      parts.push(
        <span className="mention" key={key++}>
          @{m[5]}
        </span>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts;
}
