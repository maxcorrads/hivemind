import MarkdownIt from "markdown-it";
import { useMemo, type ReactNode } from "react";

/** Parsed bodies by text, newest last: a re-rendered row reuses its parse instead of rescanning up to 20k chars. */
const parsed = new Map<string, ReactNode[]>();
const PARSED_BODIES = 1000;

/** Inline-only rendering (code, bold, @mentions) as React nodes, for search hits that need highlighting. */
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

// Message bodies are untrusted (agents, bots, Telegram): raw HTML is escaped, never parsed, and
// images are off so a message can never make the UI fetch from a third-party host.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
md.disable(["image"]);
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
md.validateLink = (url) => /^(?:https?:|mailto:)/i.test(url.trim()) || !/^[a-z][a-z0-9+.-]*:/i.test(url.trim());

const MENTION = /^@([A-Za-z][A-Za-z0-9_-]*)/;
md.inline.ruler.before("emphasis", "mention", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x40 /* @ */) return false;
  // "a@b" is not a mention: the @ must start a word.
  if (state.pos > 0 && /[\w.@-]/.test(state.src[state.pos - 1]!)) return false;
  const match = MENTION.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) state.push("mention", "", 0).content = match[1]!;
  state.pos += match[0].length;
  return true;
});
md.renderer.rules.mention = (tokens, index) => `<span class="mention">@${md.utils.escapeHtml(tokens[index]!.content)}</span>`;
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet("target", "_blank");
  tokens[index]!.attrSet("rel", "noreferrer noopener");
  return defaultLinkOpen(tokens, index, options, env, self);
};

/** Rendered bodies by text, newest last, bounded like the inline parse cache above. */
const rendered = new Map<string, string>();

/** Safe HTML for a message body: markdown (lists, quotes, emphasis, links, code) with HTML disabled. */
export function renderMarkdown(body: string): string {
  const cached = rendered.get(body);
  if (cached !== undefined) {
    rendered.delete(body);
    rendered.set(body, cached);
    return cached;
  }
  const html = md.render(body).trimEnd();
  rendered.set(body, html);
  if (rendered.size > PARSED_BODIES) rendered.delete(rendered.keys().next().value!);
  return html;
}

export function Markdown({ body, className = "msg-b md" }: { body: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(body), [body]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
