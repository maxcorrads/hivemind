/** Capture the real UI with synthetic data. No Hivemind backend or native bridge is started. */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { agents, id, launchReadme, now, project, root, shipping } from './readme-fixtures.mjs';
import { installTerminalDemo } from './readme-terminal-demo.mjs';

const output = path.join(root, 'docs/images');
const { origin, page, settle, close } = await launchReadme();
try {
  await mkdir(output, { recursive: true });
  async function capture(name, target = page) {
    await page.mouse.move(0, 0);
    await settle();
    await target.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
    console.log(`Captured ${name}.png`);
  }
  await page.goto(`${origin}/#/c/${shipping.id}/t/${id(107)}`);
  await page.locator('aside.thread').getByText('Review complete', { exact: true }).waitFor();
  await capture('coordination');
  await page.goto(`${origin}/#/tasks/${project.slug}`);
  await page.getByRole('heading', { name: 'Ship saved reading lists', exact: true }).waitFor();
  await capture('tasks');
  await page.goto(`${origin}/#/c/${shipping.id}`);
  await page.getByRole('button', { name: 'Settings for Paperplane', exact: true }).click();
  await page.getByRole('button', { name: 'Worker templates…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Worker templates for Paperplane' }).getByText('Focused verification', { exact: true }).waitFor();
  await capture('worker-templates', page.getByRole('dialog', { name: 'Worker templates for Paperplane' }));
  for (const agent of agents.filter(agent => agent.role !== 'human'))
    agent.terminalSession = `hm-paperplane-${agent.name.toLowerCase()}`;
  await installTerminalDemo(page, { agents, project, now });
  await page.setViewportSize({ width: 1160, height: 520 });
  await page.goto(`${origin}/#/c/${shipping.id}`);
  await page.reload();
  await page.getByRole('button', { name: /Terminal sessions/ }).click();
  const terminals = page.getByRole('dialog', { name: 'Terminals', exact: true });
  await terminals.getByRole('button', { name: 'Open hm-paperplane-forge', exact: true }).waitFor();
  await capture('terminals', terminals);
  for (const [worker, filename, chunks] of [['forge', 'terminal-implementation', 2], ['prism', 'terminal-review', 4]]) {
    await terminals.getByRole('button', { name: `Open hm-paperplane-${worker}`, exact: true }).click();
    await page.locator('.term[data-phase="live"]').waitFor();
    await page.waitForFunction(count => window.__readmeTerminalDemo.outputDelivered.length >= count, chunks);
    await capture(filename, terminals);
    await terminals.getByRole('button', { name: 'All sessions', exact: true }).click();
  }
  console.log('All screenshots use synthetic fixtures; no Hivemind backend was started or contacted.');
} finally {
  await close();
}
