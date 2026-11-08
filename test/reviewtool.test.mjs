import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(c.pins, [{ img: 'after', x: 52, y: 31 }]);
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
  assert.throws(() => store.addComment('demo', { round: 1, page: 'inbox', text: '[1]', pins: [{ img: 'side', x: 1, y: 1 }] }), /marked spot/);
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

test('the public side answers only requests that carry the key', async () => {
  const { dir, store } = fixture();
  store.create({ slug: 'demo' });
  const round = store.addRound('demo', { pages: [{ id: 'inbox', after: 'after1.png' }] }, dir);
  const server = createApp(store, { key: 'k3y' }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/', '/r/demo', '/api/reviews', '/api/r/demo', `/api/r/demo/img/${round.pages[0].after}`, '/api/r/demo/log']) {
      assert.equal((await fetch(base + path)).status, 403, `${path} without the key`);
      assert.equal((await fetch(`${base}${path}?key=wrong`)).status, 403, `${path} with a wrong key`);
      assert.equal((await fetch(`${base}${path}?key=k3y`)).status, 200, `${path} with the key`);
    }
    assert.equal((await fetch(`${base}/api/r/demo`, { headers: { 'x-review-key': 'k3y' } })).status, 200);
    const post = await fetch(`${base}/api/r/demo/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ round: 1, page: 'inbox', text: 'hi' }) });
    assert.equal(post.status, 403);
    assert.equal(store.get('demo').feedback.comments.length, 0);
    assert.equal((await fetch(`${base}/app.css`)).status, 200, 'styles need no key');
    // A chat shows the app in a sandboxed frame, whose requests come from an opaque origin.
    const pre = await fetch(`${base}/api/r/demo/comments?key=k3y`, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  } finally {
    server.close();
  }
});

test('the CLI runs the agent loop end to end', () => {
  const { dir } = fixture();
  const env = { ...process.env, REVIEWTOOL_TARGET: 'none', REVIEWTOOL_HOME: join(dir, 'cli-store'), REVIEWTOOL_URL: 'http://review.test' };
  const cli = (...args) => execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'reviewtool.mjs'), ...args], { env, encoding: 'utf8' });
  writeFileSync(join(dir, 'round.json'), JSON.stringify({ pages: [{ id: 'inbox', title: 'Inbox', before: 'before.png', after: 'after1.png' }] }));
  assert.match(cli('init', 'demo', '--title', 'Demo'), /http:\/\/review\.test\/r\/demo/);
  assert.match(cli('round', 'demo', join(dir, 'round.json'), '--as', 'Claude'), /added round 1 with 1 pages/);
  const store = new Store(join(dir, 'cli-store'));
  const c = store.addComment('demo', { round: 1, page: 'inbox', text: 'Make the title bigger', pin: { img: 'after', x: 10, y: 5 }, author: 'Jeroen' });
  const fb = cli('feedback', 'demo');
  assert.match(fb, new RegExp(`\\[${c.id}\\] Inbox \\(inbox\\) · round 1 · pinned on the after screenshot at 10% across, 5% down`));
  assert.match(fb, /image: .*\.png/);
  const m = store.addComment('demo', { round: 1, page: 'inbox', text: 'Align [1] with [2]', pins: [{ img: 'after', x: 20, y: 30 }, { img: 'before', x: 25, y: 30 }], author: 'Jeroen' });
  const fb2 = cli('feedback', 'demo');
  assert.match(fb2, new RegExp(`\\[${m.id}\\] Inbox \\(inbox\\) · round 1 · marks 2 spots, named \\[1\\]…\\[2\\] in the text`));
  assert.match(fb2, /\[1\] on the after screenshot at 20% across, 30% down · image: .*\.png/);
  assert.match(fb2, /\[2\] on the before screenshot at 25% across, 30% down/);
  assert.match(cli('log', 'demo'), /marks \[1\] after \(20%, 30%\), \[2\] before \(25%, 30%\)/);
  cli('resolve', 'demo', m.id);
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
  const env = { ...process.env, REVIEWTOOL_TARGET: 'none', REVIEWTOOL_HOME: home };

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

test('inside T3 Code, sending posts the feedback into the agent thread', async () => {
  const { chmodSync, mkdirSync, readFileSync } = await import('node:fs');
  const { detectTarget } = await import('../src/targets.mjs');
  const { dir, store } = fixture();
  // A stand-in for T3's command line: records its arguments and the message it gets on stdin.
  const binDir = join(dir, 'fake-t3');
  mkdirSync(binDir);
  const t3 = join(binDir, 't3');
  writeFileSync(t3, `#!/bin/sh\nif [ "$FAIL_T3" = 1 ]; then echo "server not running" >&2; exit 1; fi\necho "$@" > "${join(dir, 't3-args')}"\ncat > "${join(dir, 't3-message')}"\n`);
  chmodSync(t3, 0o755);

  assert.equal(detectTarget({ T3CODE_THREAD_ID: 'abc', T3CODE_CLI_PATH: '/usr/bin/sh' }, { lookup: false }), null, 'only a t3 binary');
  assert.equal(detectTarget({ T3CODE_THREAD_ID: 'abc', T3CODE_CLI_PATH: t3, REVIEWTOOL_TARGET: 'none' }, { lookup: false }), null);
  const target = detectTarget({ T3CODE_THREAD_ID: 'thread-1', T3CODE_CLI_PATH: t3, T3CODE_HOME: '/t3home' }, { agent: 'Claude', lookup: false });
  assert.equal(target.thread, 'thread-1');

  store.create({ slug: 'demo', title: 'Inbox redesign' });
  store.addRound('demo', { pages: [{ id: 'inbox', title: 'Inbox', after: 'after1.png' }] }, dir);
  store.setTarget('demo', { ...target, title: 'Inbox work' });
  store.addComment('demo', { round: 1, page: 'inbox', text: 'Make it calmer', author: 'Jeroen' });

  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const submit = async (note) => (await fetch(`http://127.0.0.1:${server.address().port}/api/r/demo/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'Jeroen', note }) })).json();
  try {
    const sent = await submit('Only the inbox');
    assert.equal(sent.delivery.to, 'T3 thread "Inbox work"');
    assert.equal(sent.delivery.error, null);
    assert.equal(sent.pickedUpBy, 'Claude');
    assert.equal(readFileSync(join(dir, 't3-args'), 'utf8').trim(), 'thread send --base-dir /t3home thread-1 -');
    const message = readFileSync(join(dir, 't3-message'), 'utf8');
    assert.match(message, /^Review feedback for "Inbox redesign" \(reviewtool review "demo", round 1\)/);
    assert.match(message, /Note from the reviewer:\n {2}Only the inbox/);
    assert.match(message, /Make it calmer/);
    assert.match(message, /reviewtool reply demo <id>/);

    // T3 unreachable: the feedback stays pending for the next `reviewtool wait`.
    process.env.FAIL_T3 = '1';
    const failed = await submit('again');
    assert.match(failed.delivery.error, /server not running/);
    assert.equal(failed.pickedUpAt, null);
    assert.equal(store.pickUp('demo', 'Claude').id, failed.id);
    delete process.env.FAIL_T3;

    // An agent blocked in `wait` gets it instead of the thread, so it never arrives twice.
    store.setWaiting('demo', { by: 'Claude', since: new Date().toISOString() });
    const waited = await submit('third');
    assert.equal(waited.delivery, undefined);
    assert.equal(waited.pickedUpAt, null);
  } finally {
    delete process.env.FAIL_T3;
    server.close();
  }
});

test('pages sit in folders that carry over between rounds and can be moved', () => {
  const { dir, store } = fixture();
  store.create({ slug: 'demo' });
  store.addRound('demo', { pages: [
    { id: 'members', title: 'Members', group: ' Settings / Team & access/ ', after: 'after1.png' },
    { id: 'inbox', title: 'Inbox', after: 'after1.png' },
  ] }, dir);
  const r2 = store.addRound('demo', { pages: [
    { id: 'members', title: 'Members', after: 'after2.png' },
    { id: 'inbox', title: 'Inbox', group: 'Planning', after: 'after2.png' },
  ] }, dir);
  assert.deepEqual(r2.pages.map((p) => p.group), ['Settings/Team & access', 'Planning']);
  assert.throws(() => store.addRound('demo', { pages: [{ id: 'x', after: 'after1.png', group: 42 }] }, dir), /group must be text/);

  const moved = store.setGroup('demo', { pages: ['inbox'], group: 'Planning/Daily' });
  assert.deepEqual(moved, { round: 2, group: 'Planning/Daily', pages: ['inbox'] });
  assert.equal(store.get('demo').rounds[1].pages[1].group, 'Planning/Daily');
  store.setGroup('demo', { pages: ['inbox'], group: '' });
  assert.equal(store.get('demo').rounds[1].pages[1].group, '');
  assert.throws(() => store.setGroup('demo', { pages: ['nope'], group: 'X' }), /no page "nope"/);
  assert.match(renderLog(store.get('demo')), /Settings › Team & access › Members/);
});

test('phone screenshots are always a page of their own', () => {
  const { dir, store } = fixture();
  store.create({ slug: 'demo' });
  const r1 = store.addRound('demo', { pages: [
    { id: 'inbox', title: 'Inbox', group: 'Start', after: 'after1.png', mobile: 'phone.png' },
    { id: 'inbox-drawer', title: 'Inbox menu', device: 'phone', after: 'phone.png' },
  ] }, dir);
  assert.deepEqual(r1.pages.map((p) => [p.id, p.device, p.group]), [['inbox', 'desktop', 'Start'], ['inbox-phone', 'phone', 'Start'], ['inbox-drawer', 'phone', '']]);
  assert.equal(r1.pages[1].title, 'Inbox (phone)');
  assert.equal(r1.pages[1].after, r1.pages[2].after);
  assert.equal(r1.pages[0].mobile, undefined);
  const r2 = store.addRound('demo', { pages: [{ id: 'inbox-drawer', title: 'Inbox menu', after: 'after2.png' }, { id: 'inbox', after: 'after1.png', mobile: 'phone.png' }] }, dir);
  assert.equal(r2.pages[0].device, 'phone', 'the device carries over');
  assert.equal(r2.pages.find((p) => p.id === 'inbox-phone').change.status, 'same', 'the phone page compares with its own last round');
  assert.throws(() => store.addRound('demo', { pages: [{ id: 'x', after: 'after1.png', device: 'tablet' }] }, dir), /device must be desktop or phone/);
  assert.throws(() => store.addRound('demo', { pages: [{ id: 'x', after: 'after1.png', device: 'phone', mobile: 'phone.png' }] }, dir), /takes no mobile ones/);
});

test('markers number spots across a round for a chat to refer to, and never reuse a number', () => {
  const { dir } = fixture();
  const env = { ...process.env, REVIEWTOOL_TARGET: 'none', REVIEWTOOL_HOME: join(dir, 'cli-store') };
  const cli = (...args) => execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'reviewtool.mjs'), ...args], { env, encoding: 'utf8' });
  const store = new Store(join(dir, 'cli-store'));
  store.create({ slug: 'demo' });
  store.addRound('demo', { pages: [{ id: 'inbox', title: 'Inbox', group: 'Start', before: 'before.png', after: 'after1.png' }, { id: 'team', title: 'Team', after: 'after2.png' }] }, dir);
  assert.equal(store.addMarker('demo', { round: 'latest', page: 'inbox', img: 'after', x: 10, y: 20 }).n, 1);
  assert.equal(store.addMarker('demo', { round: 1, page: 'team', img: 'after', x: 5, y: 5 }).n, 2);
  store.deleteMarker('demo', 1, 2);
  assert.equal(store.addMarker('demo', { round: 1, page: 'inbox', img: 'before', x: 50, y: 50 }).n, 3, 'a removed number is not reused');
  assert.throws(() => store.addMarker('demo', { round: 1, page: 'nope', img: 'after', x: 1, y: 1 }), /no page/);
  assert.throws(() => store.addMarker('demo', { round: 1, page: 'inbox', img: 'side', x: 1, y: 1 }), /needs img/);
  store.setVerdict('demo', { round: 1, page: 'team', verdict: 'approve' });
  const text = cli('markers', 'demo');
  assert.match(text, /^2 markers in "demo", round 1/);
  assert.match(text, /\[1\] Start › Inbox \(inbox\) · the after screenshot at 10% across, 20% down\n    image: .*\.png/);
  assert.match(text, /\[3\] Start › Inbox \(inbox\) · the before screenshot at 50% across, 50% down/);
  assert.doesNotMatch(text, /^\[2\]/m, "the removed marker is gone");
  assert.match(text, /Approved: 1 of 2 pages \(team\)/);
  assert.deepEqual(JSON.parse(cli('markers', 'demo', '--json')).markers.map((m) => m.n), [1, 3]);
});

test('reviews stored with phone variants on a page get them split into their own pages', () => {
  const { dir, store } = fixture();
  store.create({ slug: 'old' });
  const r = store.addRound('old', { pages: [{ id: 'inbox', title: 'Inbox', after: 'after1.png' }] }, dir);
  // Write the old layout by hand: a phone variant on the page, a verdict, and a comment pinned on the phone shot.
  const roundsFile = join(store.dir('old'), 'rounds.json');
  const rounds = JSON.parse(readFileSync(roundsFile, 'utf8'));
  Object.assign(rounds[0].pages[0], { mobile: r.pages[0].after, mobileBefore: null, mobileChange: null });
  writeFileSync(roundsFile, JSON.stringify(rounds));
  const feedbackFile = join(store.dir('old'), 'feedback.json');
  const feedback = JSON.parse(readFileSync(feedbackFile, 'utf8'));
  feedback.verdicts['1/inbox'] = { verdict: 'approve', by: 'J', at: '2026-01-01T00:00:00.000Z' };
  feedback.comments.push({ id: 'c1', round: 1, page: 'inbox', author: 'J', kind: 'human', text: 'too wide', pin: { img: 'mobile', x: 1, y: 2 }, replyTo: null, status: 'open', at: '2026-01-01T00:00:00.000Z' });
  writeFileSync(feedbackFile, JSON.stringify(feedback));

  const fresh = new Store(store.root);
  const { rounds: split, feedback: moved } = fresh.get('old');
  assert.deepEqual(split[0].pages.map((p) => [p.id, p.device]), [['inbox', 'desktop'], ['inbox-phone', 'phone']]);
  assert.equal(split[0].pages[0].mobile, undefined);
  assert.equal(moved.verdicts['1/inbox-phone'].verdict, 'approve');
  assert.equal(moved.comments[0].page, 'inbox-phone');
  assert.deepEqual(moved.comments[0].pins, [{ img: 'after', x: 1, y: 2 }]);
});
