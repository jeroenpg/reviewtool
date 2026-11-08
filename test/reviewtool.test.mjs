import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { MARKER, renderLog } from '../src/log.mjs';
import { createApp } from '../src/server.mjs';
import { Store, needsReply, threads } from '../src/store.mjs';

// 1x1 PNGs with different pixels, so content hashes differ.
const png = (byte) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([byte])]);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'reviewtool-'));
  for (const [name, byte] of [['before.png', 1], ['after1.png', 2], ['after2.png', 3], ['phone.png', 4]]) writeFileSync(join(dir, name), png(byte));
  return { dir, store: new Store(join(dir, 'store')) };
}

test('rounds copy images, reuse the previous before, and keep page ids', () => {
  const { dir, store } = fixture();
  store.create({ slug: 'demo', title: 'Demo', repo: 'o/r', pr: 7 });
  const r1 = store.addRound('demo', { pages: [{ id: 'inbox', title: 'Inbox', before: 'before.png', beforeLabel: 'main', after: 'after1.png' }] }, dir);
  const r2 = store.addRound('demo', { title: 'Fixes', pages: [{ id: 'inbox', title: 'Inbox', after: 'after2.png', mobile: 'phone.png' }] }, dir);
  assert.equal(r1.n, 1);
  assert.equal(r2.n, 2);
  assert.equal(r2.title, 'Fixes');
  assert.equal(r2.pages[0].before, r1.pages[0].before, 'before carried over');
  assert.equal(r2.pages[0].beforeLabel, 'main');
  assert.notEqual(r2.pages[0].after, r1.pages[0].after);
  assert.equal(readdirSync(join(dir, 'store/reviews/demo/images')).length, 4);
  assert.throws(() => store.addRound('demo', { pages: [{ id: 'x', after: 'missing.png' }] }, dir), /image not found/);
  assert.throws(() => store.addRound('demo', { pages: [{ id: 'a', after: 'after1.png' }, { id: 'a', after: 'after1.png' }] }, dir), /twice/);
});

test('threads wait for the agent until it replies, and again after the human answers', () => {
  const { dir, store } = fixture();
  store.create({ slug: 'demo' });
  store.addRound('demo', { pages: [{ id: 'inbox', after: 'after1.png' }] }, dir);
  const c = store.addComment('demo', { round: 'latest', page: 'inbox', text: 'Snooze is mid-row', pin: { img: 'after', x: 52.04, y: 31 }, author: 'Jeroen' });
  assert.deepEqual(c.pin, { img: 'after', x: 52, y: 31 });
  assert.equal(needsReply(store.get('demo').feedback.comments).length, 1);

  store.addComment('demo', { replyTo: c.id, text: 'Moved it to the end', author: 'Claude', kind: 'agent' });
  assert.equal(needsReply(store.get('demo').feedback.comments).length, 0);

  store.setStatus('demo', c.id, 'resolved');
  store.addComment('demo', { replyTo: c.id, text: 'Still odd on phones', author: 'Jeroen' });
  const [t] = threads(store.get('demo').feedback.comments);
  assert.equal(t.status, 'open', 'a human reply reopens the thread');
  assert.equal(t.replies.length, 2);
  assert.equal(needsReply(store.get('demo').feedback.comments).length, 1);

  assert.throws(() => store.addComment('demo', { round: 1, page: 'nope', text: 'x' }), /no page/);
  assert.throws(() => store.setVerdict('demo', { round: 1, page: 'inbox', verdict: 'maybe' }), /verdict/);
});

test('the log lists rounds, verdicts and threads with replies', () => {
  const { dir, store } = fixture();
  store.create({ slug: 'demo', title: 'Inbox redesign' });
  store.addRound('demo', { pages: [{ id: 'inbox', title: 'Inbox', route: '/inbox', after: 'after1.png' }] }, dir);
  store.addRound('demo', { notes: 'Moved snooze', pages: [{ id: 'inbox', title: 'Inbox', after: 'after2.png' }] }, dir);
  const c = store.addComment('demo', { round: 1, page: 'inbox', text: 'Snooze is mid-row\nsecond line', author: 'Jeroen' });
  store.addComment('demo', { replyTo: c.id, text: 'Moved it', author: 'Claude', kind: 'agent' });
  store.setVerdict('demo', { round: 2, page: 'inbox', verdict: 'approve' });
  const md = renderLog(store.get('demo'));
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /2 rounds · 1 comment thread \(0 resolved\)/);
  assert.match(md, /latest round: 1 approved/);
  assert.match(md, /<details open><summary><b>Round 2<\/b>/);
  assert.match(md, /\| Inbox \| Approved \|/);
  assert.match(md, /- \*\*Jeroen\*\* \(general\): Snooze is mid-row\n {2}second line/);
  assert.match(md, / {2}- \*\*Claude\*\*: Moved it/);
});

test('the server serves the review and accepts comments from people only', async () => {
  const { dir, store } = fixture();
  store.create({ slug: 'demo' });
  const round = store.addRound('demo', { pages: [{ id: 'inbox', after: 'after1.png' }] }, dir);
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/r/demo`)).status, 200);
    assert.equal((await fetch(`${base}/r/nope`)).status, 404);
    const img = await fetch(`${base}/api/r/demo/img/${round.pages[0].after}`);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/api/r/demo/img/..%2Freview.json`)).status, 404);
    const res = await fetch(`${base}/api/r/demo/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ round: 1, page: 'inbox', text: 'hi', kind: 'agent', author: 'Mallory' }) });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).kind, 'human');
    const v = await fetch(`${base}/api/r/demo/verdict`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ round: 1, page: 'inbox', verdict: 'update' }) });
    assert.equal((await v.json()).verdict.verdict, 'update');
    const list = await (await fetch(`${base}/api/reviews`)).json();
    assert.equal(list[0].open, 1);
    assert.match(await (await fetch(`${base}/api/r/demo/log`)).text(), /Needs update/);
  } finally {
    server.close();
  }
});

test('the CLI runs the agent loop end to end', () => {
  const { dir } = fixture();
  const env = { ...process.env, REVIEWTOOL_HOME: join(dir, 'cli-store'), REVIEWTOOL_URL: 'http://review.test' };
  const cli = (...args) => execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'reviewtool.mjs'), ...args], { env, encoding: 'utf8' });
  writeFileSync(join(dir, 'round.json'), JSON.stringify({ pages: [{ id: 'inbox', title: 'Inbox', before: 'before.png', after: 'after1.png' }] }));
  assert.match(cli('init', 'demo', '--title', 'Demo'), /http:\/\/review\.test\/r\/demo/);
  assert.match(cli('round', 'demo', join(dir, 'round.json'), '--as', 'Claude'), /added round 1 with 1 pages/);
  const store = new Store(join(dir, 'cli-store'));
  const c = store.addComment('demo', { round: 1, page: 'inbox', text: 'Make the title bigger', pin: { img: 'after', x: 10, y: 5 }, author: 'Jeroen' });
  const fb = cli('feedback', 'demo');
  assert.match(fb, new RegExp(`\\[${c.id}\\] Inbox \\(inbox\\) · round 1 · pinned on the after screenshot at 10% across, 5% down`));
  assert.match(fb, /image: .*\.png/);
  cli('reply', 'demo', c.id, 'Bumped it to 20px', '--as', 'Claude');
  assert.match(cli('feedback', 'demo'), /^0 threads waiting/);
  assert.equal(JSON.parse(cli('feedback', 'demo', '--all', '--json')).threads[0].replies[0].author, 'Claude');
  assert.match(cli('log', 'demo'), /\*\*Claude\*\*: Bumped it to 20px/);
  assert.match(cli('url', 'demo', 'inbox'), /review\.test\/r\/demo#inbox/);
});

// A real PNG (RGB, filter 0) with a white background and an optional black square.
function makePng(width, height, square = null) {
  const { deflateSync } = require('node:zlib');
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      if (square && x >= square.x && x < square.x + square.size && y >= square.y && y < square.y + square.size) row.fill(0, 1 + x * 3, 4 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (name, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); // the decoder does not check CRCs
    return Buffer.concat([len, Buffer.from(name, 'latin1'), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('new rounds mark each page as same, changed or new, with the changed area boxed', async () => {
  const { compareImages, decodePng } = await import('../src/diff.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'reviewtool-diff-'));
  writeFileSync(join(dir, 'plain.png'), makePng(200, 100));
  writeFileSync(join(dir, 'plain-copy.png'), makePng(200, 100));
  writeFileSync(join(dir, 'square.png'), makePng(200, 100, { x: 150, y: 20, size: 30 }));
  writeFileSync(join(dir, 'tall.png'), makePng(200, 120));
  const decoded = decodePng(makePng(4, 2, { x: 0, y: 0, size: 1 }));
  assert.deepEqual([...decoded.rgba.slice(0, 8)], [0, 0, 0, 255, 255, 255, 255, 255]);

  const changed = compareImages(join(dir, 'plain.png'), join(dir, 'square.png'));
  assert.equal(changed.status, 'changed');
  assert.equal(changed.ratio, 0.045); // 900 of 20000 pixels
  assert.equal(changed.boxes.length, 1);
  const [box] = changed.boxes;
  assert.ok(box.x <= 75 && box.x + box.w >= 90 && box.y <= 20 && box.y + box.h >= 50, JSON.stringify(box));
  assert.equal(compareImages(join(dir, 'plain.png'), join(dir, 'tall.png')).status, 'changed');

  const store = new Store(join(dir, 'store'));
  store.create({ slug: 'demo' });
  store.addRound('demo', { pages: [{ id: 'a', after: 'plain.png' }, { id: 'b', after: 'plain.png' }] }, dir);
  const r2 = store.addRound('demo', { pages: [{ id: 'a', after: 'plain-copy.png' }, { id: 'b', after: 'square.png' }, { id: 'c', after: 'plain.png' }] }, dir);
  assert.deepEqual(r2.pages.map((p) => p.change.status), ['same', 'changed', 'new']);
});

test('wait blocks until the reviewer sends feedback, then marks it picked up', async () => {
  const { spawn } = await import('node:child_process');
  const { dir } = fixture();
  const home = join(dir, 'wait-store');
  const store = new Store(home);
  store.create({ slug: 'demo' });
  store.addRound('demo', { pages: [{ id: 'inbox', title: 'Inbox', after: 'after1.png' }] }, dir);
  const bin = join(import.meta.dirname, '..', 'bin', 'reviewtool.mjs');
  const env = { ...process.env, REVIEWTOOL_HOME: home };

  // Times out with exit 2 when nothing is sent.
  const quick = spawn(process.execPath, [bin, 'wait', 'demo', '--timeout', '1'], { env });
  assert.equal(await new Promise((r) => quick.on('exit', r)), 2);

  const child = spawn(process.execPath, [bin, 'wait', 'demo', '--as', 'Claude'], { env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.on('exit', r));
  // The app sees the agent waiting.
  for (let i = 0; i < 50 && !store.waiting('demo'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.waiting('demo')?.by, 'Claude');

  store.addComment('demo', { round: 1, page: 'inbox', text: 'Make it calmer', author: 'Jeroen' });
  store.setVerdict('demo', { round: 1, page: 'inbox', verdict: 'update' });
  const sent = store.submit('demo', { by: 'Jeroen', note: 'Only the inbox for now' });
  assert.deepEqual([sent.comments, sent.verdicts], [1, 1]);

  assert.equal(await exited, 0);
  assert.match(out, /Feedback sent by Jeroen .* 1 new comment, 1 verdict/);
  assert.match(out, /Note from the reviewer:\n {2}Only the inbox for now/);
  assert.match(out, /Make it calmer/);
  const { feedback } = store.get('demo');
  assert.equal(feedback.submissions[0].pickedUpBy, 'Claude');
  assert.equal(store.waiting('demo'), null);
  assert.equal(store.pickUp('demo', 'Claude'), null, 'each submission is picked up once');
});
