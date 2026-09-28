/** Record the README demo GIF from the real UI with synthetic data. No Hivemind backend or native bridge is started. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atlas, channelPage, conversation, forge, id, launchReadme, now, prism, replies, root, scout, shipping,
  threads } from './readme-fixtures.mjs';

const output = path.join(root, 'docs/images/demo.gif');
const viewport = { width: 1280, height: 800 };
const live = m => ({ ...m, createdAt: now });
// The story starts in an empty room; the page's reads always see what has been posted so far.
const posted = [];
const reply = (threadId, list) => ({ [threadId]: list.filter(m => m.threadId === threadId).length });
// The roster's status lines follow the story: delegated, working, waiting for review, accepted.
const task = (n, state, objective) => ({ task: { id: id(n), channelId: shipping.id, state, objective, needed: null },
  assigned: 1, delegated: 0, toReview: 0 });
const brain = (delegated, toReview = 0) => ({ task: null, assigned: 0, delegated, toReview });
const working = { [forge.id]: task(60, 'accepted', 'Reading lists'),
  [prism.id]: task(61, 'accepted', 'UI review'), [scout.id]: task(62, 'accepted', 'Sync checks') };
let agentWork = {};
const api = (url, request) => {
  if (url.pathname === '/api/ui/nav-status') return { agentWork };
  if (!url.pathname.endsWith(`/channels/${shipping.id}/messages`)) return;
  if (request.method() === 'POST') {
    const sent = live({ ...conversation[0], body: request.postDataJSON().body });
    posted.push(sent);
    return { message: sent };
  }
  const threadId = url.searchParams.get('threadId');
  const messages = posted.filter(m => threadId ? m.id === threadId || m.threadId === threadId : !m.threadId);
  return channelPage(threadId, messages, reply(id(107), posted), Math.max(0, ...posted.map(m => m.seq)));
};
let send;
const dir = await mkdtemp(path.join(tmpdir(), 'hivemind-demo-'));
const { origin, context, page, settle, close } = await launchReadme({ viewport, recordVideo: { dir, size: viewport },
  api, socket: sender => { send = sender; } }).catch(async error => { await rm(dir, { recursive: true, force: true }); throw error; });
const launched = Date.now();
const pause = ms => page.waitForTimeout(ms);
/** Deliver a message as the hive would, then wait until the page shows it. */
async function push(m, shown = page.getByText(m.body.split('\n')[0].replace(/\*\*/g, ''), { exact: false }).first()) {
  posted.push(live(m));
  send('message', live(m));
  await shown.waitFor();
}
function work(next) {
  agentWork = next;
  send('agent-work', { agentWork });
}
let scene;
try {
  await page.goto(`${origin}/#/c/${shipping.id}`);
  const composer = page.getByRole('textbox', { name: 'Message #reading-lists' });
  await composer.waitFor();
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await settle();
  // The encoder's first frames after a still page are soft; start the clip once it has settled.
  await pause(1200);
  scene = { start: Date.now() - launched };
  await pause(800);
  await composer.click();
  await composer.pressSequentially("Let's ship **saved reading lists**: collect books, reorder them, and pick up where you left off. Keep v1 focused on private lists, keyboard access, and reliable sync.", { delay: 18 });
  await pause(500);
  await composer.press('Enter');
  await page.locator('.msg', { hasText: 'saved reading lists' }).first().waitFor();
  await pause(2200);
  await push(conversation[1]);
  work({ [atlas.id]: brain(3), ...working });
  await pause(3200);
  await push(conversation[2]);
  work({ ...agentWork, [atlas.id]: brain(3, 1), [forge.id]: task(60, 'result_submitted', 'Reading lists') });
  await pause(1400);
  for (const [i, m] of replies.slice(0, 2).entries()) {
    await push(m, page.getByRole('button', { name: `${i + 1} ${i ? 'replies' : 'reply'}`, exact: true }));
    await pause(700);
  }
  await page.getByRole('button', { name: '2 replies', exact: true }).click();
  // Video has no cursor; park the pointer and drop focus so no message toolbar lingers.
  await page.mouse.move(viewport.width / 2, viewport.height - 4);
  await page.evaluate(() => document.activeElement?.blur());
  const thread = page.locator('aside.thread');
  await thread.getByText('The retry now uses the existing operation ID', { exact: false }).waitFor();
  await pause(1800);
  await push(replies[2]);
  await pause(2600);
  await push(replies[3]);
  send('thread', { ...threads[0], status: 'done', updatedAt: now });
  work({ [atlas.id]: brain(2), [prism.id]: working[prism.id], [scout.id]: working[scout.id] });
  await pause(2800);
  await settle();
  await page.locator('button.nav', { hasText: 'Tasks' }).click();
  await page.getByRole('heading', { name: 'Ship saved reading lists', exact: true }).waitFor();
  await pause(2600);
  await settle();
  scene.end = Date.now() - launched;
  const video = page.video();
  await context.close();
  const webm = await video.path();
  // Two-pass palette: one palette for the whole clip keeps the dark UI free of banding and flicker.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(scene.start / 1000), '-t', String((scene.end - scene.start) / 1000),
    '-i', webm, '-vf', 'fps=10,scale=1040:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];' +
    '[b][p]paletteuse=dither=none:diff_mode=rectangle', '-loop', '0', output]);
  const { size } = await stat(output);
  console.log(`Recorded demo.gif (${((scene.end - scene.start) / 1000).toFixed(1)} s, ${(size / 1048576).toFixed(1)} MB)`);
  console.log('The demo uses synthetic fixtures; no Hivemind backend was started or contacted.');
} finally {
  try { await close(); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
