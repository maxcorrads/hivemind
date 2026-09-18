"""Mounted Playwright/Chromium acceptance for the Hivemind UI read-state slice.
Run after `npm run build`: python verify_ui_read_state.py /path/to/repo
Requires Playwright Python and Chromium; no changes to project dependencies/CI.
"""
import asyncio
import json
import os
import re
import sys
import shutil
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from playwright.async_api import async_playwright, expect, Error as PlaywrightError

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
NODE = os.environ.get('NODE', 'node')
CHROMIUM = os.environ.get('CHROMIUM') or shutil.which('chromium') or shutil.which('google-chrome')
if not CHROMIUM: raise RuntimeError('Set CHROMIUM to an installed Chrome/Chromium executable')
SERVER = r'''
import path from "node:path";
import { Hive } from "./src/server/hive.ts";
import { startServer } from "./src/server/serve.ts";
const hive = new Hive(path.join(process.env.UI_TEST_HOME, "hive.db"));
const service = startServer({ hive, port: 0, telegram: false });
console.log(JSON.stringify({ port: await service.ready }));
let closing = false;
process.on("SIGTERM", () => {
  if (closing) return; closing = true;
  service.server.once("close", () => { hive.db.close(); process.exit(0); });
  service.shutdown(); service.server.closeAllConnections();
});
'''

@asynccontextmanager
async def fixture(pw, browser):
    with tempfile.TemporaryDirectory(prefix='hive-ui-read-browser-') as home:
        error_file = open(Path(home) / 'server.log', 'w+')
        proc = await asyncio.create_subprocess_exec(NODE, '--import', 'tsx', '--input-type=module', '-e', SERVER,
            cwd=REPO, env={**os.environ, 'UI_TEST_HOME': home}, stdout=asyncio.subprocess.PIPE, stderr=error_file)
        context = None
        api = None
        try:
            line = await asyncio.wait_for(proc.stdout.readline(), 10)
            if not line:
                error_file.seek(0)
                raise RuntimeError(error_file.read())
            base = 'http://127.0.0.1:' + str(json.loads(line)['port'])
            context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
            await context.add_init_script('''window.testSockets = []; const Native = window.WebSocket;
              window.WebSocket = class extends Native { constructor(...args) { super(...args); window.testSockets.push(this); } };''')
            page = await context.new_page()
            api = await pw.request.new_context(base_url=base)
            async def call(method, url, data=None, token=None):
                response = await api.fetch(url, method=method, data=data, headers={'authorization': 'Bearer ' + token} if token else {})
                body = await response.json()
                assert response.ok, (response.status, body)
                return body
            brain = await call('POST', '/api/agent/join', {'role': 'brain'})
            async def post(body, root=None, channel='general', token=None):
                payload = {'body': body}
                if root: payload['threadId'] = root
                result = await call('POST', '/api/agent/channels/' + channel + '/messages', payload, token or brain['token'])
                return result
            async def reads(channel='general', n=None):
                if n is None:
                    return (await call('GET', '/api/ui/read-state'))['unread'].get(channel, 0)
                await page.wait_for_function('''async ([channel, n]) => {
                    const s = await (await fetch('/api/ui/read-state')).json(); return s.unread[channel] === n;
                }''', arg=[channel, n], timeout=5000, polling=50)
            async def go(hash):
                await page.evaluate('(hash) => { location.hash = hash; }', hash)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            yield page, base, call, post, reads, go, errors
            assert not errors, errors
        finally:
            if context: await context.close()
            if api: await api.dispose()
            if proc.returncode is None:
                proc.terminate()
                try: await asyncio.wait_for(proc.wait(), 5)
                except asyncio.TimeoutError:
                    proc.kill(); await proc.wait()
            error_file.close()

async def transitions(pw, browser):
    async with fixture(pw, browser) as (page, base, call, post, reads, go, errors):
        root = await post('@Human ROOT A')
        await post('@Human THREAD A', root['id'])
        other = await post('@Human ROOT B')
        await post('@Human THREAD B', other['id'])
        await page.goto(base + '/#/c/general')
        await expect(page.locator('main .msg-b').filter(has_text='ROOT A')).to_be_visible()
        await reads(n=2)
        await expect(page.locator('button.nav').filter(has_text='general').locator('em')).to_have_text('2')
        await page.locator('main .msg').filter(has_text='ROOT A').get_by_role('button', name='1 reply', exact=True).click()
        await expect(page.locator('aside.thread .msg-b').filter(has_text='THREAD A')).to_be_visible()
        await reads(n=1)
        await post('@Human LIVE VISIBLE REPLY', root['id'])
        await expect(page.locator('aside.thread .msg-b').filter(has_text='LIVE VISIBLE REPLY')).to_be_visible()
        await reads(n=1)
        await page.locator('aside.thread button.plus').click()
        await expect(page.locator('aside.thread')).to_have_count(0)
        await post('@Human UNOPENED LATER REPLY', root['id'])
        await expect(page.locator('button.nav').filter(has_text='general').locator('em')).to_have_text('2')
        await page.evaluate('window.testSockets.at(-1).close()')
        await expect(page.locator('.pulse')).not_to_have_class(re.compile(r'\bon\b'))
        await post('@Human OFFLINE REPLY', root['id'])
        await page.wait_for_function('window.testSockets.length >= 2 && window.testSockets.at(-1).readyState === 1')
        await expect(page.locator('button.nav').filter(has_text='general').locator('em')).to_have_text('3')
        await go('/c/general/t/' + root['id'])
        await expect(page.locator('aside.thread .msg-b').filter(has_text='OFFLINE REPLY')).to_be_visible()
        await reads(n=1)

async def project_pagination(pw, browser):
    async with fixture(pw, browser) as (page, base, call, post, reads, go, errors):
        for i in range(65): await post('@Human CHAPTER %03d' % i)
        await call('POST', '/api/ui/projects', {'name': 'Other', 'slug': 'other'})
        brain = await call('POST', '/api/agent/join', {'role': 'brain', 'project': 'other'})
        snap = await call('GET', '/api/ui/snapshot')
        channel = next(c['id'] for c in snap['channels'] if c['project'] == 'other' and c['name'] == 'general')
        for i in range(60): await post('@Human OTHER %03d' % i, channel=channel, token=brain['token'])
        await page.goto(base + '/#/inbox/chapter')
        await expect(page.locator('.inbox-item')).to_have_count(30)
        assert all('CHAPTER' in text for text in await page.locator('.inbox-item .msg-b').all_text_contents())
        assert '65' in await page.locator('.sec-badge').all_text_contents()
        await page.get_by_role('button', name='Older mentions', exact=True).click()
        await expect(page.locator('.inbox-item')).to_have_count(60)
        await page.get_by_role('button', name='Older mentions', exact=True).click()
        await expect(page.locator('.inbox-item')).to_have_count(65)
        await expect(page.get_by_role('button', name='Older mentions', exact=True)).to_have_count(0)
        texts = await page.locator('.inbox-item .msg-b').all_text_contents()
        assert len(set(texts)) == 65
        assert texts[0].endswith('064') and texts[-1].endswith('000')
        await page.get_by_role('button', name='Mark seen', exact=True).click()
        await expect(page.locator('.inbox-item')).to_have_count(0)
        assert (await call('GET', '/api/ui/read-state'))['mentionCounts']['other'] == 60
        await page.get_by_role('button', name='All', exact=True).click()
        await expect(page.locator('.inbox-item')).to_have_count(65)
        await go('/inbox/other')
        await expect(page.locator('.inbox-item')).to_have_count(30)
        assert all('OTHER' in text for text in await page.locator('.inbox-item .msg-b').all_text_contents())

async def forward_thread_history(pw, browser):
    async with fixture(pw, browser) as (page, base, call, post, reads, go, errors):
        root = await post('@Human LARGE ROOT')
        for i in range(100): await post('@Human REPLY %03d' % i, root['id'])
        await page.goto(base + '/#/c/general')
        await reads(n=100)
        await go('/c/general/t/' + root['id'])
        await expect(page.locator('aside.thread .msg')).to_have_count(80)
        await reads(n=21)
        await page.get_by_role('button', name='Load more replies', exact=True).click()
        await expect(page.locator('aside.thread .msg')).to_have_count(101)
        await expect(page.locator('aside.thread .msg-b').filter(has_text='REPLY 099')).to_be_visible()
        await reads(n=0)
        await expect(page.get_by_role('button', name='Load more replies', exact=True)).to_have_count(0)

async def delayed_navigation(pw, browser):
    async with fixture(pw, browser) as (page, base, call, post, reads, go, errors):
        await post('@Human NEVER DISPLAYED A')
        room = (await call('POST', '/api/ui/channels', {'name': 'second', 'type': 'public', 'project': 'chapter'}))['channel']
        await post('@Human DISPLAYED B', channel=room['id'])
        captured, release = asyncio.Event(), asyncio.Event()
        async def block(route):
            response = await route.fetch()
            captured.set()
            await release.wait()
            try: await route.fulfill(response=response)
            except PlaywrightError: pass  # Navigation may have aborted the old browser request.
        await page.route('**/api/ui/channels/general/messages', block)
        try:
            await page.goto(base + '/#/c/general')
            await asyncio.wait_for(captured.wait(), 5)
            await go('/c/' + room['id'])
            await expect(page.locator('main .msg-b').filter(has_text='DISPLAYED B')).to_be_visible()
            await reads(channel=room['id'], n=0)
            release.set()
            # A UI fetch after releasing the barrier gives queued callbacks an event-loop turn.
            await call('GET', '/api/ui/read-state')
            await expect(page.locator('main .msg-b').filter(has_text='NEVER DISPLAYED A')).to_have_count(0)
            assert await reads() == 1
        finally:
            release.set()

async def delayed_thread(pw, browser):
    async with fixture(pw, browser) as (page, base, call, post, reads, go, errors):
        root = await post('@Human ROOT FOR DELAY')
        await post('@Human UNSEEN DELAYED THREAD', root['id'])
        other = await post('@Human OTHER ROOT')
        await post('@Human VISIBLE OTHER THREAD', other['id'])
        await page.goto(base + '/#/c/general')
        await reads(n=2)
        captured, release = asyncio.Event(), asyncio.Event()
        async def block(route):
            response = await route.fetch(); captured.set(); await release.wait()
            try: await route.fulfill(response=response)
            except PlaywrightError: pass
        await page.route('**/api/ui/channels/general/messages?threadId=' + root['id'], block)
        try:
            await go('/c/general/t/' + root['id'])
            await asyncio.wait_for(captured.wait(), 5)
            await go('/c/general/t/' + other['id'])
            await expect(page.locator('aside.thread .msg-b').filter(has_text='VISIBLE OTHER THREAD')).to_be_visible()
            await reads(n=1)
            release.set(); await call('GET', '/api/ui/read-state')
            await expect(page.locator('aside.thread .msg-b').filter(has_text='UNSEEN DELAYED THREAD')).to_have_count(0)
            assert await reads() == 1
        finally:
            release.set()

async def stale_receipt(pw, browser):
    async with fixture(pw, browser) as (page, base, call, post, reads, go, errors):
        root = await post('@Human ROOT FOR ACK')
        captured, release = asyncio.Event(), asyncio.Event()
        blocked_once = False
        async def block(route):
            nonlocal blocked_once
            if blocked_once: return await route.continue_()
            blocked_once = True
            response = await route.fetch(); captured.set(); await release.wait()
            try: await route.fulfill(response=response)
            except PlaywrightError: pass
        await page.route('**/api/ui/read', block)
        try:
            await page.goto(base + '/#/c/general')
            await asyncio.wait_for(captured.wait(), 5)
            await post('@Human NEWER THAN ACK', root['id'])
            await expect(page.locator('button.nav').filter(has_text='general').locator('em')).to_have_text('1')
            release.set()
            await go('/inbox/chapter')
            await expect(page.locator('.inbox-item')).to_have_count(1)
            await expect(page.locator('.inbox-item .msg-b')).to_contain_text('NEWER THAN ACK')
            assert await reads() == 1
        finally:
            release.set()

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=CHROMIUM, headless=True, args=['--no-sandbox'])
        try:
            for test in [transitions, project_pagination, delayed_navigation, delayed_thread, stale_receipt, forward_thread_history]:
                await test(pw, browser)
                print('PASS', test.__name__, flush=True)
        finally:
            await browser.close()

if __name__ == '__main__': asyncio.run(main())
