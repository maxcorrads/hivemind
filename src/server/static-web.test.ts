import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createStaticWeb } from './static-web.ts';

function request(serve: ReturnType<typeof createStaticWeb>, url: string) {
  let status: number | null = null, headers: Record<string, string> = {}, body = '';
  const res = {
    writeHead(code: number, next: Record<string, string>) { status = code; headers = next; },
    end(bytes: Buffer) { body = bytes.toString(); },
  } as unknown as ServerResponse;
  return { served: serve(res, url), status, headers, body };
}

test('static package catalog serves nested assets, query strings and SPA routes', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hive-static-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'web'); mkdirSync(path.join(bundle, 'assets'), { recursive: true });
  writeFileSync(path.join(bundle, 'index.html'), '<main>Hive</main>');
  const cases = [
    ['app.js', 'text/javascript; charset=utf-8'], ['app.css', 'text/css; charset=utf-8'],
    ['icon.svg', 'image/svg+xml'], ['data.json', 'application/json'],
    ['font.woff2', 'font/woff2'], ['binary.dat', 'application/octet-stream'],
  ];
  for (const [name] of cases) writeFileSync(path.join(bundle, 'assets', name!), name!);
  const serve = createStaticWeb(bundle);
  for (const [name, type] of cases) {
    const response = request(serve, `/assets/${name}?cache=1`);
    assert.equal(response.status, 200); assert.equal(response.headers['Content-Type'], type);
    assert.equal(response.body, name);
  }
  for (const route of ['/', '/index.html', '/project/channel', '/assets', '/missing-file']) {
    const response = request(serve, route);
    assert.equal(response.served, true); assert.equal(response.body, '<main>Hive</main>');
    assert.equal(response.headers['Content-Type'], 'text/html; charset=utf-8');
  }
});

test('request paths never traverse the package catalog or follow outside symlinks', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hive-static-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'web'); mkdirSync(bundle);
  writeFileSync(path.join(bundle, 'index.html'), 'safe entry');
  writeFileSync(path.join(root, 'secret.txt'), 'must not escape');
  const outside = path.join(root, 'outside'); mkdirSync(outside);
  writeFileSync(path.join(outside, 'private.txt'), 'outside directory');
  symlinkSync(path.join(root, 'secret.txt'), path.join(bundle, 'linked.txt'));
  symlinkSync(outside, path.join(bundle, 'linked-dir'), 'dir');
  const serve = createStaticWeb(bundle);
  for (const url of [
    '/../secret.txt', '/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt',
    '/..\\secret.txt', '/linked.txt', '/linked-dir/private.txt', '//etc/passwd', '/\0',
  ]) {
    const response = request(serve, url);
    assert.equal(response.body, 'safe entry', url);
    assert.doesNotMatch(response.body, /must not escape|outside directory/);
  }
  // Runtime filesystem replacements cannot influence a catalog already loaded.
  rmSync(path.join(bundle, 'index.html'));
  symlinkSync(path.join(root, 'secret.txt'), path.join(bundle, 'index.html'));
  assert.equal(request(serve, '/').body, 'safe entry');
});

test('an absent build or missing SPA entry falls through without writing a response', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hive-static-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(request(createStaticWeb(path.join(root, 'absent')), '/'),
    { served: false, status: null, headers: {}, body: '' });
  writeFileSync(path.join(root, 'only.js'), 'asset');
  const serve = createStaticWeb(root);
  assert.equal(request(serve, '/only.js').body, 'asset');
  assert.equal(request(serve, '/unknown').served, false);
});
