import { expect, test, type Route } from "./fixtures.ts";

import type { Agent, Channel, Message, Project } from "../../src/shared/types.ts";
import type { TaskEnvelope } from "../../src/shared/tasks.ts";
import type { ChannelPayload, Snapshot } from "../../web/api.ts";

// Slack-style stream (#221): grouping, markdown, dividers, cards, system rows and Mark unread, in a real browser.
const agent = (id: string, name: string, role: Agent["role"]): Agent => ({ id, name, role, seniority: null, focus: null,
  online: true, lastSeenAt: 1, createdAt: 1, projectId: null, project: null });
const human = agent("human", "Human", "human"), atlas = agent("atlas", "Atlas", "brain"), forge = agent("forge", "Forge", "worker");
const hive: Project = { id: "project-alpha", slug: "alpha", name: "Alpha", worktree: null, createdAt: 1 };
const room: Channel = { id: "room", name: "design", type: "public", topic: null, createdBy: "human", createdAt: 1,
  memberIds: ["human", "atlas", "forge"], projectId: hive.id, project: hive.slug };
// Fixed wall-clock times keep the Today/Yesterday dividers stable whatever time the suite runs.
const today = new Date(); today.setHours(9, 0, 0, 0);
const at = (minutesAgo: number) => today.getTime() - minutesAgo * 60_000;
const message = (seq: number, author: Agent, body: string, createdAt: number, patch: Partial<Message> = {}): Message => ({
  id: `m${seq}`, seq, channelId: room.id, threadId: null, authorId: author.id, authorName: author.name, authorRole: author.role,
  body, kind: "chat", control: null, mentions: [], createdAt, ...patch });
const envelope: TaskEnvelope = { taskId: "m5", channelId: room.id, revision: 1, contractVersion: 1, actorId: "atlas",
  actorRole: "brain", assignerId: "atlas", workerId: "forge", action: { type: "assign", contract: { objective: "Ship the message stream",
    scope: ["web"], nonGoals: [], acceptanceCriteria: ["Tests pass"], dependencies: [], evidenceSeqs: [] } } };
const messages = [
  message(1, human, "Atlas created #design", at(24 * 60 + 5), { kind: "system" }),
  message(2, atlas, "Yesterday's plan:\n- **grouping**\n- markdown", at(24 * 60)),
  message(3, atlas, "and a follow-up in the same group", at(24 * 60 - 2)),
  message(4, forge, "See https://example.com/spec for details, @Atlas", at(30)),
  message(5, atlas, "Task assign · m5 · revision 1 / contract 1\nObjective: Ship the message stream", at(20), { taskEvent: envelope }),
  message(6, forge, "Picked it up", at(10)),
  message(7, forge, "First draft is ready", at(9)),
];

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test("the stream groups, dividers, cards and system rows, and Mark unread moves the divider", async ({ page }) => {
  const reads = { readInstance: "stream-fixture", readRevision: 0, readSeq: 7, unread: { room: 2 }, mentions: [],
    mentionsHasMore: false, mentionCounts: {} };
  const snap: Snapshot = { ...reads, you: human, projects: [hive], agents: [human, atlas, forge], channels: [room], queued: {},
    telegram: { running: false, configured: false } };
  const unread: unknown[] = [];
  await page.route("**/api/**", route => route.fulfill({ status: 501, body: "{}" }));
  await page.route("**/api/ui/session", route => json(route, { ok: true }));
  await page.route("**/api/ui/snapshot", route => json(route, snap));
  await page.route("**/api/ui/read-state", route => json(route, reads));
  await page.route("**/api/ui/read", route => json(route, reads));
  await page.route("**/api/ui/unread", route => { unread.push(route.request().postDataJSON()); return json(route, { ...reads, readRevision: 1 }); });
  await page.route("**/api/ui/mentions?*", route => json(route, { ...reads, messages: [], hasMore: false }));
  await page.route("**/api/ui/channels/*/room", route => json(route, { room: null, tasks: [], activeTaskCount: 0,
    tasksHasMore: false, nextTaskCursor: null, links: [], unmanagedBots: [] }));
  await page.route("**/api/ui/channels/*/messages*", route => json(route, { channel: room, threadId: null, messages,
    hasOlder: false, hasNewer: false, threads: [], replyCounts: { m6: 2 }, snapshotSeq: 7, firstUnreadSeq: 6,
    cursors: { before: 1, after: 7 } } satisfies ChannelPayload));
  await page.routeWebSocket("**/ws", socket => socket.send(JSON.stringify({ type: "hello", payload: null, streamId: "s", sequence: 1 })));
  await page.goto("/#/c/room");

  const stream = page.locator("main .stream");
  await expect(stream.locator(".msg")).toHaveCount(7);
  await expect(stream.getByRole("separator", { name: "Today" })).toBeVisible();
  await expect(stream.getByRole("separator", { name: "Yesterday" })).toBeVisible();
  await expect(stream.locator(".msg.sys")).toHaveText(/Atlas created #design/);
  await expect(stream.locator(".msg.sys .avatar")).toHaveCount(0);
  await expect(stream.locator(".msg.grouped")).toHaveCount(2);
  await expect(stream.locator(".msg-b li strong")).toHaveText("grouping");
  await expect(stream.getByRole("link", { name: "https://example.com/spec" })).toHaveAttribute("target", "_blank");
  await expect(stream.locator(".task-event .card-title")).toHaveText("Ship the message stream");
  await expect(stream.locator(".task-event")).toContainText("Atlas → Forge");
  await expect(stream.getByRole("button", { name: "2 replies" })).toBeVisible();
  await expect(stream.locator(".stream-divider.unread")).toHaveAccessibleName("New messages");
  await expect(stream.locator(".stream-divider.unread + .msg")).toContainText("Picked it up");
  await page.screenshot({ path: test.info().outputPath("stream.png") });

  const draft = stream.locator(".msg").filter({ hasText: "and a follow-up" });
  await draft.hover();
  await draft.getByRole("button", { name: "Mark unread" }).click();
  expect(unread).toEqual([{ channelId: "room", fromSeq: 3 }]);
  await expect(stream.locator(".stream-divider.unread + .msg")).toContainText("and a follow-up");
});
