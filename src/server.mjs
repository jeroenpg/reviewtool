// HTTP server for the review app: the list of reviews at /, one review at /r/<name>, and a small JSON API.
// Pull-based: the app only records approvals and markers. Feedback is the reviewer's chat message, and the agent pulls
// the approvals and markers with the CLI. Nothing a browser sends reaches an agent as text.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLog } from './log.mjs';
import { ReviewError } from './store.mjs';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new ReviewError('body too large', 413);
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new ReviewError('body is not JSON');
  }
}

function send(res, status, payload, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  if (status === 204) return res.end();
  res.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
}

// Served to anyone, also without the key: they hold nothing about a review.
const OPEN = new Set(['/favicon.svg', '/vendor/pico.zinc.min.css', '/app.css', '/marks.js']);

function sameKey(given, key) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The review app. With `key`, every request must carry it (?key= or the x-review-key header): that is the app as the
 * public internet reaches it, through a relay. Without, it trusts whoever can reach it (localhost, the tailnet).
 */
export function createApp(store, { key = null } = {}) {
  const page = (name) => readFileSync(join(publicDir, name));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (key) {
      // A chat that shows the app in a sandboxed frame gives it an opaque origin, so even its own requests count as
      // cross-site. The key, not the origin, guards this side, so any origin may ask.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type, x-review-key');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
      res.setHeader('access-control-max-age', '600');
      if (req.method === 'OPTIONS') return send(res, 204, null);
    }
    if (key && !OPEN.has(url.pathname) && !sameKey(url.searchParams.get('key') ?? req.headers['x-review-key'], key)) {
      return send(res, 403, 'This link needs its key. Ask the agent for the full link.', 'text/plain; charset=utf-8');
    }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method;

    if (method === 'GET' && parts.length === 0) return send(res, 200, page('home.html'), 'text/html; charset=utf-8');
    if (method === 'GET' && parts[0] === 'r' && parts.length === 2) {
      store.mustDir(parts[1]);
      return send(res, 200, page('review.html'), 'text/html; charset=utf-8');
    }
    if (method === 'GET' && url.pathname === '/favicon.svg') return send(res, 200, page('favicon.svg'), 'image/svg+xml', { 'cache-control': 'max-age=86400' });
    if (method === 'GET' && url.pathname === '/vendor/pico.zinc.min.css') return send(res, 200, page('vendor/pico.zinc.min.css'), 'text/css; charset=utf-8', { 'cache-control': 'max-age=86400' });
    if (method === 'GET' && url.pathname === '/marks.js') return send(res, 200, page('marks.js'), 'text/javascript; charset=utf-8', { 'cache-control': 'no-cache' });
    if (method === 'GET' && url.pathname === '/app.css') return send(res, 200, page('app.css'), 'text/css; charset=utf-8', { 'cache-control': 'no-cache' });
    if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });

    if (method === 'GET' && parts[1] === 'reviews' && parts.length === 2) return send(res, 200, store.list());
    if (parts[1] !== 'r' || !parts[2]) return send(res, 404, { error: 'not found' });
    const slug = parts[2];
    const rest = parts.slice(3);

    if (method === 'GET' && rest.length === 0) return send(res, 200, { ...store.get(slug), waiting: store.waiting(slug) });
    if (method === 'GET' && rest[0] === 'img' && rest.length === 2) {
      let bytes;
      try {
        bytes = await readFile(store.imagePath(slug, rest[1]));
      } catch (error) {
        if (error instanceof ReviewError) throw error;
        return send(res, 404, { error: 'image not found' });
      }
      // Content-addressed, so it never changes.
      return send(res, 200, bytes, TYPES[rest[1].split('.').pop()], { 'cache-control': 'public, max-age=31536000, immutable' });
    }
    if (method === 'GET' && rest[0] === 'log' && rest.length === 1) {
      return send(res, 200, renderLog(store.get(slug), { url: `${url.protocol}//${req.headers.host}/r/${slug}` }), 'text/markdown; charset=utf-8');
    }
    if (method === 'PUT' && rest[0] === 'verdict' && rest.length === 1) {
      const { round, page: pageId, verdict = null, by = null } = await body(req);
      return send(res, 200, { verdict: store.setVerdict(slug, { round: Number(round), page: pageId, verdict, by }) });
    }
    if (method === 'POST' && rest[0] === 'markers' && rest.length === 1) {
      const { round, page: pageId, img, x, y, by } = await body(req);
      return send(res, 201, store.addMarker(slug, { round, page: pageId, img, x, y, by }));
    }
    if (method === 'DELETE' && rest[0] === 'markers' && rest.length === 3) {
      store.deleteMarker(slug, rest[1], rest[2]);
      return send(res, 204, null);
    }
    return send(res, 404, { error: 'not found' });
  }

  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof ReviewError ? error.status : 500;
      if (status === 500) console.error(error);
      send(res, status, { error: error.message });
    });
  });
}
