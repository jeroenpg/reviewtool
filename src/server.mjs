// HTTP server for the review app: the list of reviews at /, one review at /r/<name>, and a small JSON API.
import { createServer } from 'node:http';
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

export function createApp(store) {
  const page = (name) => readFileSync(join(publicDir, name));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method;

    if (method === 'GET' && parts.length === 0) return send(res, 200, page('home.html'), 'text/html; charset=utf-8');
    if (method === 'GET' && parts[0] === 'r' && parts.length === 2) {
      store.mustDir(parts[1]);
      return send(res, 200, page('review.html'), 'text/html; charset=utf-8');
    }
    if (method === 'GET' && url.pathname === '/favicon.svg') return send(res, 200, page('favicon.svg'), 'image/svg+xml', { 'cache-control': 'max-age=86400' });
    if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });

    if (method === 'GET' && parts[1] === 'reviews' && parts.length === 2) return send(res, 200, store.list());
    if (parts[1] !== 'r' || !parts[2]) return send(res, 404, { error: 'not found' });
    const slug = parts[2];
    const rest = parts.slice(3);

    if (method === 'GET' && rest.length === 0) return send(res, 200, store.get(slug));
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
    if (method === 'POST' && rest[0] === 'comments' && rest.length === 1) {
      const { round, page: pageId, text, pin, replyTo, author } = await body(req);
      // The browser always speaks for a person; agents use the CLI.
      return send(res, 201, store.addComment(slug, { round, page: pageId, text, pin, replyTo, author, kind: 'human' }));
    }
    if (rest[0] === 'comments' && rest.length === 2) {
      if (method === 'PATCH') {
        const { status } = await body(req);
        return send(res, 200, store.setStatus(slug, rest[1], status));
      }
      if (method === 'DELETE') {
        store.deleteComment(slug, rest[1]);
        return send(res, 204, null);
      }
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
