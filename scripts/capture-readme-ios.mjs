/**
 * Capture the Human UI as the iPhone and iPad app shows it: the real built page in Chromium, sized like the app's
 * web view, with the iOS app's bridge mocked. No Hivemind backend, native bridge, or simulator is started.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agents, id, launchReadme, now, project, root, shipping } from './readme-fixtures.mjs';
import { installTerminalDemo } from './readme-terminal-demo.mjs';

const output = path.join(root, 'docs/images');
// The app shows the page full screen; WebKit lays it out inside the safe areas (ios/Sources/SceneController.swift),
// so the page's viewport is the screen less the status bar and home indicator. The app sets no user agent of its
// own: these are WKWebView's defaults (desktop-class on iPad).
const devices = {
  iphone: { screen: { width: 393, height: 852 }, safe: { top: 59, bottom: 34 }, radius: 55, bezel: 12,
    context: { deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' } },
  ipad: { screen: { width: 1376, height: 1032 }, safe: { top: 24, bottom: 20 }, radius: 18, bezel: 18,
    context: { deviceScaleFactor: 1, isMobile: false, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)' } },
};
for (const agent of agents.filter(agent => agent.role !== 'human'))
  agent.terminalSession = `hm-paperplane-${agent.name.toLowerCase()}`;

async function withDevice(name, scenes) {
  const { screen, safe, radius, bezel, context: device } = devices[name];
  const viewport = { width: screen.width, height: screen.height - safe.top - safe.bottom };
  const { origin, context, page, settle, close } = await launchReadme({ viewport, device });
  try {
    await installTerminalDemo(page, { agents, project, now, platform: 'ios' });
    /** Screenshot the page, then show it in a plain device outline; the safe areas take the page's background. */
    const capture = async filename => {
      await page.mouse.move(0, 0);
      await settle();
      const shot = await page.screenshot({ animations: 'disabled' });
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const frame = await context.newPage();
      await frame.setViewportSize({ width: screen.width + 2 * bezel, height: screen.height + 2 * bezel });
      await frame.setContent(`<!doctype html><style>
        html, body { margin: 0; background: transparent; }
        .device { width: ${screen.width}px; padding: ${bezel}px; border-radius: ${radius + bezel}px; background: #0b0b0d;
          box-shadow: inset 0 0 0 1.5px #3a3b40; }
        .screen { box-sizing: border-box; height: ${screen.height}px; padding: ${safe.top}px 0 ${safe.bottom}px;
          border-radius: ${radius}px; overflow: hidden; background: ${background}; }
        img { display: block; width: ${viewport.width}px; height: ${viewport.height}px; }
      </style><div class="device"><div class="screen"><img src="data:image/png;base64,${shot.toString('base64')}" alt=""></div></div>`);
      await frame.locator('img').evaluate(img => img.decode());
      await writeFile(path.join(output, filename + '.png'), await frame.locator('.device').screenshot({ omitBackground: true }));
      await frame.close();
      console.log(`Captured ${filename}.png`);
    };
    await scenes({ origin, page, capture });
  } finally {
    await close();
  }
}

await mkdir(output, { recursive: true });
await withDevice('iphone', async ({ origin, page, capture }) => {
  await page.goto(`${origin}/#/c/${shipping.id}/t/${id(107)}`);
  await page.getByText('Review complete', { exact: true }).waitFor();
  await capture('ios-iphone-chat');
  await page.goto(`${origin}/#/`);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: /Terminal sessions/ }).click();
  const terminals = page.getByRole('dialog', { name: 'Terminals', exact: true });
  await terminals.getByRole('button', { name: 'Open hm-paperplane-forge', exact: true }).waitFor();
  // The page took the app's "ios": sessions show only in the page, with no Terminal.app action.
  assert.equal(await terminals.getByRole('button', { name: /in Terminal$/ }).count(), 0, 'The iOS page offers no Terminal.app');
  await terminals.getByRole('button', { name: 'Open hm-paperplane-forge', exact: true }).click();
  await page.locator('.term[data-phase="live"]').waitFor();
  await page.waitForFunction(() => window.__readmeTerminalDemo.outputDelivered.length >= 2);
  await capture('ios-iphone-terminal');
});
await withDevice('ipad', async ({ origin, page, capture }) => {
  await page.goto(`${origin}/#/c/${shipping.id}/t/${id(107)}`);
  await page.locator('aside.thread').getByText('Review complete', { exact: true }).waitFor();
  await capture('ios-ipad');
  await page.getByRole('button', { name: 'Settings for Paperplane', exact: true }).waitFor();
  await page.locator('summary[title="Settings and tools"]').click();
  await page.getByRole('button', { name: 'Switch Mac…', exact: true }).waitFor();
});
console.log('All iOS screenshots use synthetic fixtures and a mocked iOS bridge; no Hivemind backend was started or contacted.');
