import { parseSearchQuery } from "../src/shared/search-query.ts";
import { renderBody } from "./markdown.tsx";

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Renders a message body with every search token wrapped in `<mark class="hit">`. */
export function renderSearchBody(body: string, q: string) {
  const tokens = parseSearchQuery(q).filter((token) => token.length > 0);
  if (tokens.length === 0) return renderBody(body);
  const re = new RegExp(tokens.map(escapeRegExp).join("|"), "gi");
  const parts: ReturnType<typeof renderBody> = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index === last && m[0] === "") {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) parts.push(...renderBody(body.slice(last, m.index)));
    parts.push(
      <mark className="hit" key={`hit-${key++}`}>
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(...renderBody(body.slice(last)));
  return parts;
}
