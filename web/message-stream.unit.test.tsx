import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskEnvelope } from "../src/shared/tasks.ts";
import type { Message } from "../src/shared/types.ts";
import { taskBody } from "../src/shared/tasks.ts";
import { renderMarkdown } from "./markdown.tsx";
import { dayLabel, formatTime, GROUP_WINDOW_MS, streamRows } from "./message-stream.ts";
import { Msg } from "./Msg.tsx";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, location: window.location, HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
after(() => window.happyDOM.close());
let unmounts: Array<() => void> = [];
afterEach(() => {
  for (const unmount of unmounts.reverse()) unmount();
  unmounts = [];
  document.body.innerHTML = "";
});
async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(node));
  unmounts.push(() => act(() => root.unmount()));
  return host;
}

const NOON = new Date(2026, 8, 24, 12, 0).getTime();
let seq = 0;
function message(patch: Partial<Message> = {}): Message {
  seq++;
  return { id: `m${seq}`, seq, channelId: "c1", threadId: null, authorId: "forge", authorName: "Forge", authorRole: "worker",
    body: `Body ${seq}`, kind: "chat", control: null, mentions: [], createdAt: NOON, ...patch };
}
const kinds = (rows: ReturnType<typeof streamRows>) =>
  rows.map((row) => row.type === "message" ? (row.grouped ? "grouped" : "msg") : row.type === "date" ? `date:${row.label}` : "new");

test("consecutive messages of one author within five minutes are grouped; anything in between breaks the group", () => {
  const a = message(), b = message({ createdAt: NOON + 60_000 }), c = message({ createdAt: NOON + 60_000 + GROUP_WINDOW_MS });
  const d = message({ authorId: "cipher", authorName: "Cipher", createdAt: c.createdAt + 1 });
  const e = message({ authorId: "cipher", kind: "system", createdAt: d.createdAt + 1 });
  const f = message({ authorId: "cipher", createdAt: e.createdAt + 1 });
  assert.deepEqual(kinds(streamRows([a, b, c, d, e, f], { now: NOON })), ["date:Today", "msg", "grouped", "msg", "msg", "msg", "msg"]);
});

test("task events stand alone as cards", () => {
  const envelope = { taskId: "t1", channelId: "c1", revision: 1, contractVersion: 1, actorId: "forge", actorRole: "brain",
    assignerId: "forge", workerId: "w", action: { type: "accept" } } as TaskEnvelope;
  const rows = streamRows([message(), message({ taskEvent: envelope }), message()], { now: NOON });
  assert.deepEqual(kinds(rows), ["date:Today", "msg", "msg", "msg"]);
});

test("date dividers mark each day and the New messages divider sits before the first unread message", () => {
  const yesterday = message({ createdAt: NOON - 86_400_000 });
  const old = message({ createdAt: new Date(2025, 0, 6, 9).getTime() });
  const today = message(), unread = message({ createdAt: NOON + 1_000 }), later = message({ createdAt: NOON + 2_000 });
  assert.deepEqual(kinds(streamRows([old, yesterday, today, unread, later], { firstUnreadSeq: unread.seq, now: NOON })),
    [`date:${dayLabel(old.createdAt, NOON)}`, "msg", "date:Yesterday", "msg", "date:Today", "msg", "new", "msg", "grouped"]);
  assert.match(dayLabel(old.createdAt, NOON), /2025/);
  assert.doesNotMatch(dayLabel(NOON - 3 * 86_400_000, NOON), /2026/);
  assert.deepEqual(kinds(streamRows([today], { firstUnreadSeq: null, now: NOON })), ["date:Today", "msg"]);
});

test("times read like Slack, without a zero-padded hour", () => {
  // ICU may put a narrow no-break space before the day period.
  const time = (at: Date) => formatTime(at.getTime(), "en-US").replace(/\s/g, " ");
  assert.equal(time(new Date(2026, 0, 1, 1, 26)), "1:26 AM");
  assert.equal(time(new Date(2026, 0, 1, 13, 5)), "1:05 PM");
});

test("markdown renders lists, quotes, emphasis, links and mentions, and never raw HTML or script links", () => {
  const html = renderMarkdown("- one\n- **two**\n> quoted _text_\n\nsee https://example.com and @Forge, not a@b.com");
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li><strong>two<\/strong><\/li>\s*<\/ul>/);
  assert.match(html, /<blockquote>\s*<p>quoted <em>text<\/em><\/p>\s*<\/blockquote>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noreferrer noopener">/);
  assert.match(html, /<span class="mention">@Forge<\/span>/);
  assert.doesNotMatch(html, /@b\.com<\/span>/);
  const hostile = renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(1)"> [a](javascript:alert(1)) ' +
    '[b](JaVaScRiPt:alert(1)) [c](data:text/html,x) ![d](https://tracker.example/p.png) <a href="javascript:x">e</a>');
  assert.doesNotMatch(hostile, /<script|<img|<a href="(?:javascript|data)|href="JaVa/i);
  assert.match(hostile, /&lt;script&gt;/);
  assert.match(renderMarkdown("```\n<b>code</b>\n```"), /<pre><code>&lt;b&gt;code&lt;\/b&gt;/);
  assert.match(renderMarkdown("line 1\nline 2"), /line 1<br>\s*line 2/);
});

test("system messages render as a centered line without the Human's name or avatar", () => {
  const html = renderToStaticMarkup(<Msg m={message({ kind: "system", authorId: "human", authorName: "Human", authorRole: "human",
    body: "Cipher created #design-review" })} replies={0} status={null} onReact={() => undefined} />);
  assert.match(html, /class="msg sys kind-system"/);
  assert.match(html, /Cipher created #design-review/);
  assert.doesNotMatch(html, /Human|avatar|msg-tools/);
});

test("a grouped follow-up has no header; the Thread line appears only when there are replies", () => {
  const m = message();
  const grouped = renderToStaticMarkup(<Msg m={m} grouped replies={0} status={null} onThread={() => undefined} onReact={() => undefined} />);
  assert.doesNotMatch(grouped, /msg-h|class="avatar/);
  assert.match(grouped, /class="gutter-time"/);
  assert.doesNotMatch(grouped, /class="replies"/);
  assert.match(grouped, /aria-label="Reply in thread"/);
  const replied = renderToStaticMarkup(<Msg m={m} replies={2} status={null} onThread={() => undefined} />);
  assert.match(replied, /class="replies"[^>]*><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg>2 replies</);
  const open = renderToStaticMarkup(<Msg m={m} replies={2} status={null} threadOpen onThread={() => undefined} />);
  assert.match(open, /class="replies open"/, "the summary of the open thread is highlighted");
  assert.match(renderToStaticMarkup(<Msg m={m} grouped replies={0} status="blocked" />), /msg-h/, "a thread status keeps its header");
});

test("task messages render as compact cards with the raw text behind Contract details", () => {
  const envelope: TaskEnvelope = { taskId: "3f2a9c1e-0000-4000-8000-000000000000", channelId: "c1", revision: 1, contractVersion: 1,
    actorId: "b", actorRole: "brain", assignerId: "b", workerId: "w", action: { type: "assign", contract: {
      objective: "Ship the <b>stream</b>", scope: ["web"], nonGoals: [], acceptanceCriteria: ["Tests pass"], dependencies: [], evidenceSeqs: [],
    } } };
  const task = renderToStaticMarkup(<Msg m={message({ taskEvent: envelope, body: taskBody(envelope) })} replies={0} status={null}
    taskRoute="Atlas → Forge" onThread={() => undefined} />);
  assert.match(task, /class="tone-chip accent">Assigned</);
  assert.match(task, /class="card-id"[^>]*>3f2a9c1e · rev 1</);
  assert.match(task, /class="card-title">Ship the &lt;b&gt;stream&lt;\/b&gt;</);
  assert.match(task, /Atlas → Forge/);
  assert.match(task, />Open task</);
  assert.match(task, /<details><summary>Contract details<\/summary><div class="card-raw">Task assign · 3f2a9c1e/);
  assert.doesNotMatch(task, /class="msg-b/);

  // A request from the removed Human decision queue is plain history now: its text, not a card.
  const legacy = message({ eventType: "question", body: "Decision needed · task t1 · task revision 2\nQuestion: Keep the legacy API?" });
  const plain = renderToStaticMarkup(<Msg m={legacy} replies={0} status={null} onThread={() => undefined} />);
  assert.match(plain, /class="msg-b/);
  assert.match(plain, /Keep the legacy API\?/);
  assert.doesNotMatch(plain, /stream-card/);
  assert.equal(kinds(streamRows([message(), legacy], { now: NOON })).at(-1), "grouped", "it groups like any chat message");
});

test("the hover toolbar replies in thread, copies a thread link, marks unread and reacts from the bigger picker", async () => {
  const copies: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } });
  const m = message();
  const events: string[] = [];
  const host = await mount(<Msg m={m} replies={0} status={null} onThread={(anchor) => events.push(`thread:${anchor.tagName}`)}
    onReact={(emoji) => events.push(`react:${emoji}`)} onMarkUnread={(target) => events.push(`unread:${target.seq}`)} />);
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  await act(async () => button("Reply in thread").click());
  await act(async () => button("Copy link").click());
  await act(async () => button("Mark unread").click());
  assert.equal(host.querySelector(".emoji-picker"), null);
  await act(async () => button("More reactions").click());
  await act(async () => host.querySelector<HTMLButtonElement>('.emoji-picker button[title="🎉"]')!.click());
  assert.deepEqual(events, ["thread:ARTICLE", `unread:${m.seq}`, "react:🎉"]);
  assert.deepEqual(copies, [`http://localhost/#/c/c1/t/${m.id}`]);
  assert.equal(host.querySelector(".emoji-picker"), null, "reacting closes the picker");
});

test("a long press opens the toolbar on touch and a touch elsewhere closes it", async () => {
  const host = await mount(<Msg m={message()} replies={0} status={null} onReact={() => undefined} />);
  const article = host.querySelector("article")!;
  await act(async () => {
    article.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 520));
  });
  assert.ok(article.classList.contains("tools-open"));
  await act(async () => document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event));
  assert.equal(article.classList.contains("tools-open"), false);
  await act(async () => {
    article.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }) as unknown as Event);
    article.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 520));
  });
  assert.equal(article.classList.contains("tools-open"), false, "a tap is not a long press");
});
