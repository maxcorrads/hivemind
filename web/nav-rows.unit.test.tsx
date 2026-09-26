import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Channel } from "../src/shared/types.ts";
import type { Snapshot } from "./api.ts";
import { AgentList } from "./AgentList.tsx";
import { ChannelItem } from "./ChannelNav.tsx";
import { ProjectRail } from "./ProjectRail.tsx";
import type { SettingsMenuProps } from "./SettingsMenu.tsx";

const channel = (patch: Partial<Channel>): Channel => ({ id: "c", name: "general", type: "public", topic: null, createdBy: "human", createdAt: 0,
  memberIds: ["human"], projectId: "p", project: "example", ...patch });
const agent = (patch: Partial<Agent>): Agent => ({ id: "a", name: "Atlas", role: "brain", seniority: null, focus: null, online: true, lastSeenAt: 0,
  createdAt: 0, projectId: "p", project: "example", ...patch });
const noop = () => {};

test("a channel row draws its icon but still reads as \"# name\"; a DM shows its agent without renaming the row", () => {
  const html = renderToStaticMarkup(<ChannelItem ch={channel({ type: "private" })} unread={0} active={false} onClick={noop} onUnread={noop} />);
  assert.match(html, /lucide-lock/);
  assert.match(html, /<span><span class="sr-only"># <\/span>general<\/span>/);
  const dm = renderToStaticMarkup(<ChannelItem ch={channel({ type: "dm", name: "Atlas" })} unread={0} active={false}
    peer={agent({})} onClick={noop} onUnread={noop} />);
  assert.match(dm, /<span class="nav-avatar" aria-hidden="true"><span class="avatar xs role-brain"[^>]*data-on="1"/);
  assert.match(dm, /<span>Atlas<\/span><\/button>/);
});

test("roster rows put role and status on the name line, and a bot shows where it posts", () => {
  const html = renderToStaticMarkup(<AgentList projectName="Example" queued={{}} onCreateBot={noop} onOpen={noop} onAskClear={noop} onAskRemove={noop}
    agents={[agent({}), agent({ id: "w", name: "Forge", role: "worker", seniority: "senior", focus: "frontend", online: false }),
      agent({ id: "b", name: "Feed", role: "bot" })]} botChannels={{ b: "#general" }}
    work={{ w: { assigned: 1, delegated: 0, toReview: 0, task: { state: "blocked", needed: "API contract", objective: "UI" } } as never }} />);
  assert.match(html, /<span class="pn" title="Atlas">Atlas<\/span><span class="person-role">brain<\/span><span class="person-status "/);
  assert.match(html, /<i class="sdot " aria-hidden="true"><\/i>.*Forge.*<span class="person-role">senior<\/span><span class="person-status blocked"[^>]*>blocked: API contract</);
  assert.match(html, /<span class="person-meta"><span class="focus" title="frontend">frontend<\/span><\/span>/);
  assert.match(html, /lucide-bot.*Feed.*<span class="person-status "[^>]*>#general</);
});

test("the project rail holds Help, Settings and the Human only when it is given the settings", () => {
  const snap = { projects: [{ id: "p", slug: "example", name: "Example Place", worktree: null, createdAt: 0 }], channels: [], unread: {}, mentionCounts: {},
    archivedChannelIds: [] } as unknown as Snapshot;
  const bare = renderToStaticMarkup(<ProjectRail snap={snap} selectedProject="example" onSelect={noop} onNewProject={noop} />);
  assert.match(bare, /class="rail-project active "[^>]*aria-label="Example Place"[^>]*aria-current="page"/);
  assert.doesNotMatch(bare, /rail-tools|tools-menu/);
  const settings = { theme: "light", onToggleTheme: noop, layout: "rail", onLayout: noop, telegram: undefined, onTelegram: noop, onAdaptiveRouting: noop,
    onLaunch: noop, onHelp: noop, notifications: { supported: false, enabled: false, blocked: false, toggle: async () => {} } } as unknown as SettingsMenuProps;
  const full = renderToStaticMarkup(<ProjectRail snap={snap} selectedProject="example" onSelect={noop} onNewProject={noop} settings={settings} live />);
  assert.match(full, /class="rail-tools"><button type="button" class="icon-btn" title="How to join" aria-label="Help">/);
  assert.match(full, /class="tools-menu"/);
  assert.match(full, /role="img" aria-label="You are Human"[^>]*>Hu<i class="sdot ok"/);
});
