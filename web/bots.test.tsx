/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentList } from "./AgentList.tsx";
import { SearchDesk } from "./SearchDesk.tsx";
import { BotOrigin, BotSetup } from "./Bots.tsx";
import type { Agent } from "../src/shared/types.ts";
import { createBotSchema } from "../src/shared/bot-message.ts";

test("the create action lives in the bot section even with no bots", () => {
  const html = renderToStaticMarkup(<AgentList agents={[]} projectName="Example"
    onCreateBot={() => {}} queued={{}} onOpen={() => {}} onAskClear={() => {}} onAskRemove={() => {}} />);
  assert.match(html, /class="group-h bot-h" title="Integrations that post updates into channels. Bots never take tasks."><span>Bots<\/span><button/);
  assert.match(html, /aria-label="Create bot in Example"/);
});

test("bot roster rows are visible but do not offer a DM or clear-context action", () => {
  const bot: Agent = { id: "fixture", name: "UpdatesBot", role: "bot", projectId: "project", project: "example",
    seniority: null, focus: null, online: false, lastSeenAt: 0, createdAt: 0 };
  const html = renderToStaticMarkup(<AgentList agents={[bot]} projectName="Example"
    onCreateBot={() => {}} queued={{}} onOpen={() => {}} onAskClear={() => {}} onAskRemove={() => {}} />);
  assert.match(html, /UpdatesBot/);
  assert.match(html, /class="person-main" disabled=""/);
  assert.doesNotMatch(html, /title="clear context"/);
});

test("project bot setup renders its scope and no stored credential", () => {
  const html = renderToStaticMarkup(<BotSetup project={{ id: "p", name: "Example", slug: "example", worktree: null, createdAt: 0 }}
    onCreated={() => {}} onBusy={() => {}} />);
  assert.match(html, /Create a bot in <strong>Example<\/strong>/);
  assert.match(html, /aria-label="Bot name"/);
  assert.match(html, /starts without channels/);
  assert.doesNotMatch(html, /aria-label="Bot token"/);
});

test('bot credentials action is separate from disabled DM and clear-context controls', () => {
  const bot: Agent = { id: 'fixture', name: 'FixtureFeed', role: 'bot', projectId: 'project', project: 'example',
    seniority: null, focus: null, online: false, lastSeenAt: 0, createdAt: 0 };
  const html = renderToStaticMarkup(<AgentList agents={[bot]} projectName="Example" onManageBot={() => {}}
    onCreateBot={() => {}} queued={{}} onOpen={() => {}} onAskClear={() => {}} onAskRemove={() => {}} />);
  assert.match(html, /aria-label="Actions for FixtureFeed"/);
  assert.doesNotMatch(html, /Manage credentials|>Credentials</);
  assert.match(html, /class="person-main" disabled=""/);
  assert.doesNotMatch(html, /title="clear context"/);
});

test("the rendered bot name pattern compiles in HTML UnicodeSets mode and matches server validation", () => {
  const html = renderToStaticMarkup(<BotSetup project={{ id: "p", name: "Example", slug: "example", worktree: null, createdAt: 0 }}
    onCreated={() => {}} onBusy={() => {}} />);
  const pattern = html.match(/pattern="([^"]+)"/)?.[1];
  assert.ok(pattern);
  const compiled = new RegExp(`^(?:${pattern})$`, "v");
  for (const name of ["UpdatesBot", "a", "Bot-name_123", "A".repeat(40), "", "9bot", "two words", "A/B", "A|B", "Bot😀", "A".repeat(41)]) {
    assert.equal(compiled.test(name), createBotSchema.safeParse({ name }).success, name);
  }
});

test("bot origin renders an escaped label, original link and copy action", () => {
  const html = renderToStaticMarkup(<BotOrigin event={{ eventId: "one", origin: {
    label: "<script>not code</script>", author: "Example author", url: "https://example.invalid/events/1", occurredAt: 0,
  } }} />);
  assert.match(html, /Bot observation/);
  assert.match(html, /&lt;script&gt;not code&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/example.invalid\/events\/1" target="_blank" rel="noreferrer"/);
  assert.match(html, />Copy link<\/button>/);
  assert.match(html, /datetime="1970-01-01T00:00:00\.000Z"/i);
  assert.equal(renderToStaticMarkup(<BotOrigin />), "");
});

test("bot origin actions in search are outside the result navigation button", () => {
  const html = renderToStaticMarkup(<SearchDesk hiveName="Example" q="observation" hits={[{
    seq: 1, channelId: "channel", channelName: "problem", channelType: "private", threadId: null,
    authorName: "UpdatesBot", authorRole: "bot", body: "An observation", createdAt: 0, kind: "chat",
    attachments: [], reactions: [], botEvent: { eventId: "one", origin: { url: "https://example.invalid/1" } },
  }]} hasMore={false} busy={false} onOpen={() => {}} onOlder={() => {}} onClear={() => {}} />);
  let buttonDepth = 0;
  for (const tag of html.matchAll(/<\/?(?:button|a)\b[^>]*>/g)) {
    if (tag[0].startsWith("</button")) buttonDepth--;
    else if (tag[0].startsWith("<button")) {
      assert.equal(buttonDepth, 0, "Buttons must not be nested");
      buttonDepth++;
    } else if (tag[0].startsWith("<a")) assert.equal(buttonDepth, 0, "Original links must not trigger result navigation");
  }
  assert.equal(buttonDepth, 0);
  assert.match(html, />Copy link<\/button>/);
  assert.match(html, /open conversation/);
});
