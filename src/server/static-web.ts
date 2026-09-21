import type { ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2',
};
type Asset = { body: Buffer; contentType: string };

/** Build a read-only catalog from trusted package files, never from an HTTP path.
 * Symlinks are not assets. A request can only select already-loaded bytes or the
 * SPA entry point; it cannot feed a filename into any filesystem operation.
 * Production bundles are immutable for a server lifetime (Vite owns dev mode).
 */
export function createStaticWeb(webRoot: string): (res: ServerResponse, url: string) => boolean {
  const assets = new Map<string, Asset>();
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const key = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(file, key);
      else if (entry.isFile()) assets.set(key, {
        body: readFileSync(file), contentType: CONTENT_TYPES[path.extname(entry.name)] ?? 'application/octet-stream',
      });
    }
  };
  if (existsSync(webRoot)) visit(webRoot, '');
  return (res, url) => {
    const clean = url.split('?')[0] ?? '/';
    const asset = assets.get(clean) ?? assets.get('/index.html');
    if (!asset) return false;
    res.writeHead(200, { 'Content-Type': asset.contentType });
    res.end(asset.body);
    return true;
  };
}
