// File-backed store for reviews. One folder per review under the store root:
//   review.json    { slug, title, repo, pr, branch, createdAt }
//   rounds.json    [{ n, title, notes, by, createdAt, pages: [{ id, title, group, device, route, before, beforeLabel, after, afterLabel, note, change }] }]
//                  A page's phone screenshots ("mobile" in a manifest) become a page of their own, "<id>-phone".
//   feedback.json  { verdicts: { "<round>/<page>": { verdict, by, at } }, comments: [{ id, round, page, author, kind, text, pins, replyTo, status, at }] }
//                  pins: the spots a comment marks; its text names them as [1], [2], … (older comments hold one `pin`)
//   images/<sha>.<ext>  content-addressed copies of every screenshot, so a deleted worktree never takes them along.
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { compareImages } from './diff.mjs';

export const VERDICTS = ['approve', 'update', 'revert'];
export const IMAGE_FILE = /^[a-f0-9]{20}\.(png|jpe?g|webp|gif)$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEVICES = ['desktop', 'phone'];

/** A folder for a page: "Settings" or nested "Settings/Team & access". Empty means no folder. */
export function cleanGroup(group) {
  if (group == null) return '';
  if (typeof group !== 'string') throw new ReviewError('group must be text, like "Settings" or "Settings/Team & access"');
  const parts = group.split('/').map((x) => x.trim()).filter(Boolean);
  if (parts.join('/').length > 120) throw new ReviewError(`group "${group}" is too long`);
  return parts.join('/');
}
const PIN_TARGETS = ['before', 'after', 'previous'];
const MAX_PINS = 26;

export function defaultRoot() {
  if (process.env.REVIEWTOOL_HOME) return resolve(process.env.REVIEWTOOL_HOME);
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'reviewtool');
}

export class ReviewError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A directory lock shared by the server and the CLI, so an agent replying while the user comments never loses a write.
function withLock(dir, fn) {
  const lock = join(dir, '.lock');
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() - started > 15_000) throw new ReviewError('review is locked by another writer', 503);
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const now = () => new Date().toISOString();
const key = (round, page) => `${round}/${page}`;

export class Store {
  migrated = new Set();

  constructor(root = defaultRoot()) {
    this.root = root;
    this.reviewsDir = join(root, 'reviews');
  }

  dir(slug) {
    if (!SLUG.test(String(slug))) throw new ReviewError(`invalid review name "${slug}": use lowercase letters, digits and dashes`);
    return join(this.reviewsDir, slug);
  }

  exists(slug) {
    return existsSync(join(this.dir(slug), 'review.json'));
  }

  list() {
    if (!existsSync(this.reviewsDir)) return [];
    return readdirSync(this.reviewsDir)
      .filter((slug) => SLUG.test(slug) && existsSync(join(this.reviewsDir, slug, 'review.json')))
      .map((slug) => {
        const { review, rounds, feedback } = this.get(slug);
        const latest = rounds.at(-1);
        const verdicts = { approve: 0, update: 0, revert: 0 };
        for (const p of latest?.pages ?? []) {
          const v = feedback.verdicts[`${latest.n}/${p.id}`]?.verdict;
          if (v) verdicts[v]++;
        }
        return {
          ...review,
          rounds: rounds.length,
          pages: latest?.pages.length ?? 0,
          verdicts,
          threads: threads(feedback.comments).length,
          open: needsReply(feedback.comments).length,
          latestRoundAt: latest?.createdAt ?? null,
          waiting: this.waiting(slug),
          pendingSubmission: feedback.submissions.some((x) => !x.pickedUpAt),
          updatedAt: [review.createdAt, latest?.createdAt, ...feedback.comments.map((c) => c.at)].filter(Boolean).sort().at(-1),
        };
      })
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  create({ slug, title, repo = null, pr = null, branch = null }) {
    const dir = this.dir(slug);
    if (this.exists(slug)) throw new ReviewError(`review "${slug}" already exists`, 409);
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ReviewError('repo must look like owner/name');
    mkdirSync(join(dir, 'images'), { recursive: true });
    const review = { slug, title: title || slug, repo, pr: pr == null ? null : Number(pr), branch, createdAt: now() };
    writeJson(join(dir, 'review.json'), review);
    writeJson(join(dir, 'rounds.json'), []);
    writeJson(join(dir, 'feedback.json'), { verdicts: {}, comments: [], submissions: [] });
    return review;
  }

  update(slug, patch) {
    const dir = this.mustDir(slug);
    return withLock(dir, () => {
      const review = readJson(join(dir, 'review.json'));
      for (const field of ['title', 'repo', 'pr', 'branch']) if (patch[field] !== undefined) review[field] = field === 'pr' && patch.pr != null ? Number(patch.pr) : patch[field];
      writeJson(join(dir, 'review.json'), review);
      return review;
    });
  }

  /** Where feedback goes on send (see targets.mjs); null means agents pick it up with `reviewtool wait`. */
  setTarget(slug, target) {
    const dir = this.mustDir(slug);
    return withLock(dir, () => {
      const review = readJson(join(dir, 'review.json'));
      review.target = target ?? null;
      writeJson(join(dir, 'review.json'), review);
      return review;
    });
  }

  /** Records how a submission was handed over: delivered into a chat thread, or that delivery failed (stays pending). */
  recordDelivery(slug, id, { to, by = null, error = null }) {
    return this.mutateFeedback(slug, (feedback) => {
      const s = (feedback.submissions ?? []).find((x) => x.id === id);
      if (!s) throw new ReviewError(`no submission ${id}`, 404);
      s.delivery = { to, at: now(), error };
      if (!error && !s.pickedUpAt) {
        s.pickedUpAt = now();
        s.pickedUpBy = by || to;
      }
      return s;
    });
  }

  mustDir(slug) {
    const dir = this.dir(slug);
    if (!existsSync(join(dir, 'review.json'))) throw new ReviewError(`no review "${slug}"; create it with: reviewtool init ${slug}`, 404);
    if (!this.migrated.has(slug)) {
      this.migrated.add(slug);
      splitStoredPhones(dir);
    }
    return dir;
  }

  get(slug) {
    const dir = this.mustDir(slug);
    const feedback = readJson(join(dir, 'feedback.json'), { verdicts: {}, comments: [] });
    feedback.submissions ??= [];
    feedback.markers ??= [];
    return {
      review: readJson(join(dir, 'review.json')),
      rounds: readJson(join(dir, 'rounds.json'), []),
      feedback,
    };
  }

  imagePath(slug, file) {
    if (!IMAGE_FILE.test(file)) throw new ReviewError('bad image name', 404);
    return join(this.mustDir(slug), 'images', file);
  }

  importImage(slug, source) {
    const ext = extname(source).toLowerCase().replace('.jpeg', '.jpg');
    if (!/^\.(png|jpg|webp|gif)$/.test(ext)) throw new ReviewError(`unsupported image type: ${source} (png, jpg, webp or gif)`);
    let bytes;
    try {
      bytes = readFileSync(source);
    } catch {
      throw new ReviewError(`image not found: ${source}`);
    }
    const name = createHash('sha256').update(bytes).digest('hex').slice(0, 20) + ext;
    const target = join(this.mustDir(slug), 'images', name);
    if (!existsSync(target)) copyFileSync(source, target);
    return name;
  }

  /**
   * Adds the next round. Image paths are files on disk, relative to baseDir. A page that names no before reuses the
   * before of the same page in the previous round (the "main" screenshot rarely changes); pass before: null to drop it.
   */
  addRound(slug, manifest, baseDir = process.cwd()) {
    const dir = this.mustDir(slug);
    if (!manifest || !Array.isArray(manifest.pages) || manifest.pages.length === 0) throw new ReviewError('a round needs at least one page');
    manifest = { ...manifest, pages: splitPhones(manifest.pages) };
    const seen = new Set();
    for (const p of manifest.pages) {
      if (!PAGE_ID.test(String(p.id ?? ''))) throw new ReviewError(`page id "${p.id}" is invalid: letters, digits, dot, dash, underscore`);
      if (seen.has(p.id)) throw new ReviewError(`page id "${p.id}" appears twice`);
      seen.add(p.id);
      if (!p.after) throw new ReviewError(`page "${p.id}" has no after image`);
      cleanGroup(p.group);
      if (p.device !== undefined && !DEVICES.includes(p.device)) throw new ReviewError(`page "${p.id}": device must be ${DEVICES.join(' or ')}`);
    }
    // Copy images outside the lock (slow), then append the round under it.
    const imported = manifest.pages.map((p) => {
      const img = (field) => (p[field] ? this.importImage(slug, resolve(baseDir, p[field])) : p[field] === null ? null : undefined);
      return { p, before: img('before'), after: img('after') };
    });
    // Compare with the previous round outside the lock too; pixel diffs of large screenshots take a moment.
    const basis = readJson(join(dir, 'rounds.json'), []).at(-1);
    const changes = new Map(imported.map(({ p, after }) => [p.id, this.changeSince(slug, basis, basis?.pages.find((x) => x.id === p.id), after)]));
    return withLock(dir, () => {
      const rounds = readJson(join(dir, 'rounds.json'), []);
      const previous = rounds.at(-1);
      const round = {
        n: (previous?.n ?? 0) + 1,
        title: manifest.title || `Round ${(previous?.n ?? 0) + 1}`,
        notes: manifest.notes || '',
        by: manifest.by || null,
        createdAt: now(),
        pages: imported.map(({ p, before, after }) => {
          const prev = previous?.pages.find((x) => x.id === p.id);
          return {
            id: p.id,
            title: p.title || p.id,
            // A page keeps last round's folder unless the manifest names one ("" takes it out of its folder).
            group: p.group === undefined ? prev?.group ?? '' : cleanGroup(p.group),
            // "phone": the before and after are phone screenshots.
            device: p.device ?? prev?.device ?? 'desktop',
            route: p.route || '',
            before: before === undefined ? prev?.before ?? null : before,
            beforeLabel: p.beforeLabel || (before === undefined ? prev?.beforeLabel : null) || 'before',
            after,
            afterLabel: p.afterLabel || 'after',
            note: p.note || '',
            // Another round landing in between (rare) would leave the comparison against a stale basis; redo it then.
            change: previous?.n === basis?.n ? changes.get(p.id) : this.changeSince(slug, previous, prev, after),
          };
        }),
      };
      rounds.push(round);
      writeJson(join(dir, 'rounds.json'), rounds);
      return round;
    });
  }

  /** How a screenshot differs from the same page's screenshot in the previous round. */
  changeSince(slug, previousRound, prevPage, file, field = 'after') {
    if (!previousRound) return null;
    if (!prevPage) return { status: 'new', ratio: null, boxes: [] };
    if (!prevPage[field]) return { status: 'unknown', ratio: null, boxes: [] };
    if (prevPage[field] === file) return { status: 'same', ratio: 0, boxes: [] };
    try {
      return compareImages(this.imagePath(slug, prevPage[field]), this.imagePath(slug, file));
    } catch {
      return { status: 'unknown', ratio: null, boxes: [] };
    }
  }

  mutateFeedback(slug, fn) {
    const dir = this.mustDir(slug);
    return withLock(dir, () => {
      const rounds = readJson(join(dir, 'rounds.json'), []);
      const feedback = readJson(join(dir, 'feedback.json'), { verdicts: {}, comments: [] });
      const result = fn(feedback, rounds);
      writeJson(join(dir, 'feedback.json'), feedback);
      return result;
    });
  }

  /** Puts pages of a round into a folder (or out of any with ""). Returns the pages it moved. */
  setGroup(slug, { round = 'latest', pages: ids, group }) {
    const dir = this.mustDir(slug);
    const clean = cleanGroup(group);
    return withLock(dir, () => {
      const rounds = readJson(join(dir, 'rounds.json'), []);
      const r = round === 'latest' || round == null ? rounds.at(-1) : rounds.find((x) => x.n === Number(round));
      if (!r) throw new ReviewError(`no round ${round}`, 404);
      const missing = ids.filter((id) => !r.pages.some((p) => p.id === id));
      if (missing.length) throw new ReviewError(`no page ${missing.map((m) => `"${m}"`).join(', ')} in round ${r.n}`, 404);
      for (const p of r.pages) if (ids.includes(p.id)) p.group = clean;
      writeJson(join(dir, 'rounds.json'), rounds);
      return { round: r.n, group: clean, pages: ids };
    });
  }

  setVerdict(slug, { round, page, verdict, by = null }) {
    if (verdict != null && !VERDICTS.includes(verdict)) throw new ReviewError(`verdict must be one of ${VERDICTS.join(', ')} or empty`);
    return this.mutateFeedback(slug, (feedback, rounds) => {
      findPage(rounds, round, page);
      if (verdict == null) delete feedback.verdicts[key(round, page)];
      else feedback.verdicts[key(round, page)] = { verdict, by, at: now() };
      return feedback.verdicts[key(round, page)] ?? null;
    });
  }

  addComment(slug, { round, page, text, pin = null, pins = null, replyTo = null, author, kind = 'human' }) {
    if (typeof text !== 'string' || !text.trim()) throw new ReviewError('empty comment');
    if (text.length > 20_000) throw new ReviewError('comment too long');
    if (!['human', 'agent'].includes(kind)) throw new ReviewError('kind must be human or agent');
    const marks = (pins ?? (pin ? [pin] : [])).map(cleanPin);
    if (marks.length > MAX_PINS) throw new ReviewError(`a comment marks at most ${MAX_PINS} spots`);
    if (marks.some((m) => !m)) throw new ReviewError(`a marked spot needs img (${PIN_TARGETS.join(', ')}) and x, y from 0 to 100`);
    return this.mutateFeedback(slug, (feedback, rounds) => {
      let parent = null;
      if (replyTo) {
        parent = feedback.comments.find((c) => c.id === replyTo);
        if (!parent) throw new ReviewError(`no comment ${replyTo}`, 404);
        if (parent.replyTo) parent = feedback.comments.find((c) => c.id === parent.replyTo) ?? parent;
        round = parent.round;
        page = parent.page;
      } else {
        if (round == null || round === 'latest') round = rounds.at(-1)?.n;
        findPage(rounds, Number(round), page);
      }
      const comment = {
        id: newId(feedback.comments),
        round: Number(round),
        page,
        author: String(author || (kind === 'agent' ? 'Agent' : 'You')).slice(0, 60),
        kind,
        text: text.trim(),
        pins: parent ? [] : marks,
        replyTo: parent?.id ?? null,
        status: 'open',
        at: now(),
      };
      feedback.comments.push(comment);
      // A human answering reopens the thread; it needs the agent again.
      if (parent && kind === 'human' && parent.status === 'resolved') parent.status = 'open';
      return comment;
    });
  }

  setStatus(slug, id, status) {
    if (!['open', 'resolved'].includes(status)) throw new ReviewError('status must be open or resolved');
    return this.mutateFeedback(slug, (feedback) => {
      const c = feedback.comments.find((x) => x.id === id);
      if (!c) throw new ReviewError(`no comment ${id}`, 404);
      const root = c.replyTo ? feedback.comments.find((x) => x.id === c.replyTo) : c;
      root.status = status;
      root.statusAt = now();
      return root;
    });
  }

  /**
   * A numbered spot on a screenshot that the reviewer talks about elsewhere, in an agent chat: "[3] is too tall".
   * Numbers run across the whole round and are never reused, so what was said about [3] keeps pointing at it.
   */
  addMarker(slug, { round, page, img, x, y, by = null }) {
    const spot = cleanPin({ img, x, y });
    if (!spot) throw new ReviewError(`a marker needs img (${PIN_TARGETS.join(', ')}) and x, y from 0 to 100`);
    return this.mutateFeedback(slug, (feedback, rounds) => {
      if (round == null || round === 'latest') round = rounds.at(-1)?.n;
      findPage(rounds, Number(round), page);
      feedback.markers ??= [];
      feedback.markerSeq ??= {};
      const n = (feedback.markerSeq[round] ?? Math.max(0, ...feedback.markers.filter((m) => m.round === Number(round)).map((m) => m.n))) + 1;
      feedback.markerSeq[round] = n;
      const marker = { n, round: Number(round), page, ...spot, by, at: now() };
      feedback.markers.push(marker);
      return marker;
    });
  }

  deleteMarker(slug, round, n) {
    return this.mutateFeedback(slug, (feedback) => {
      const before = (feedback.markers ??= []).length;
      feedback.markers = feedback.markers.filter((m) => !(m.round === Number(round) && m.n === Number(n)));
      if (feedback.markers.length === before) throw new ReviewError(`no marker [${n}] in round ${round}`, 404);
      return true;
    });
  }

  deleteComment(slug, id) {
    return this.mutateFeedback(slug, (feedback) => {
      const before = feedback.comments.length;
      feedback.comments = feedback.comments.filter((c) => c.id !== id && c.replyTo !== id);
      if (feedback.comments.length === before) throw new ReviewError(`no comment ${id}`, 404);
      return true;
    });
  }

  /**
   * The reviewer is done for now: everything since the last submission goes to the agent. An agent blocked in
   * `reviewtool wait` picks it up; until then it stays pending.
   */
  submit(slug, { round, by = null, note = '' } = {}) {
    if (typeof note !== 'string' || note.length > 20_000) throw new ReviewError('note must be text');
    return this.mutateFeedback(slug, (feedback, rounds) => {
      const n = round == null || round === 'latest' ? rounds.at(-1)?.n : Number(round);
      if (!rounds.some((r) => r.n === n)) throw new ReviewError(`no round ${round}`, 404);
      const changes = unsent(feedback);
      const submission = {
        id: newId(feedback.submissions ?? []),
        round: n,
        by: by ? String(by).slice(0, 60) : null,
        note: note.trim(),
        comments: changes.comments.length,
        verdicts: changes.verdicts.length,
        at: now(),
        pickedUpAt: null,
        pickedUpBy: null,
      };
      (feedback.submissions ??= []).push(submission);
      return submission;
    });
  }

  /** Marks the oldest submission no agent has picked up yet as picked up, and returns it (or null). */
  pickUp(slug, by = 'Agent') {
    return this.mutateFeedback(slug, (feedback) => {
      const s = (feedback.submissions ?? []).find((x) => !x.pickedUpAt);
      if (!s) return null;
      s.pickedUpAt = now();
      s.pickedUpBy = String(by).slice(0, 60);
      return s;
    });
  }

  /** Heartbeat of an agent blocked in `reviewtool wait`, so the app can show that someone is waiting. */
  setWaiting(slug, waiter) {
    const file = join(this.mustDir(slug), 'waiting.json');
    if (waiter) writeJson(file, { ...waiter, beat: now() });
    else rmSync(file, { force: true });
  }

  waiting(slug) {
    const w = readJson(join(this.mustDir(slug), 'waiting.json'), null);
    return w && Date.now() - new Date(w.beat).getTime() < WAIT_FRESH_MS ? w : null;
  }
}

const WAIT_FRESH_MS = 15_000;

/** Human comments and replies made after the last submission that no agent has answered yet, and newer verdicts. */
export function unsent(feedback) {
  const since = (feedback.submissions ?? []).at(-1)?.at ?? '';
  const resolved = (c) => feedback.comments.find((m) => m.id === (c.replyTo ?? c.id))?.status === 'resolved';
  const answered = (c) => feedback.comments.some((m) => m.kind === 'agent' && (m.replyTo ?? m.id) === (c.replyTo ?? c.id) && m.at > c.at);
  return {
    comments: feedback.comments.filter((c) => c.kind === 'human' && c.at > since && !answered(c) && !resolved(c)),
    verdicts: Object.entries(feedback.verdicts).filter(([, v]) => v.at > since).map(([key, v]) => ({ key, ...v })),
  };
}

function findPage(rounds, round, page) {
  const r = rounds.find((x) => x.n === Number(round));
  if (!r) throw new ReviewError(`no round ${round}`, 404);
  const p = r.pages.find((x) => x.id === page);
  if (!p) throw new ReviewError(`no page "${page}" in round ${round}`, 404);
  return p;
}

function newId(comments) {
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (!comments.some((c) => c.id === id)) return id;
  }
}

/**
 * Desktop and phone are never one page: a manifest page's phone screenshots ("mobile", "mobileBefore") become a phone
 * page of their own, "<id>-phone", right after it. Its before carries over from last round like any page's.
 */
export function splitPhones(pages) {
  return pages.flatMap((p) => {
    if (!p.mobile) {
      if (p.mobileBefore) throw new ReviewError(`page "${p.id}" has a mobileBefore but no mobile screenshot`);
      return [p];
    }
    if (p.device === 'phone') throw new ReviewError(`page "${p.id}" is a phone page; its before and after are the phone screenshots, so it takes no mobile ones`);
    const { mobile, mobileBefore, ...desktop } = p;
    const phone = { id: `${p.id}-phone`, title: `${p.title || p.id} (phone)`, group: p.group, device: 'phone', route: p.route, after: mobile };
    if (mobileBefore !== undefined) phone.before = mobileBefore;
    return [desktop, phone];
  });
}

/** Reviews stored before that split: give their phone variants pages of their own too, with their comments and verdicts. */
function splitStoredPhones(dir) {
  const roundsFile = join(dir, 'rounds.json');
  if (!readJson(roundsFile, []).some((r) => r.pages.some((p) => p.mobile))) return;
  withLock(dir, () => {
    const rounds = readJson(roundsFile, []);
    const feedback = readJson(join(dir, 'feedback.json'), { verdicts: {}, comments: [] });
    for (const round of rounds) {
      round.pages = round.pages.flatMap((p) => {
        const { mobile, mobileBefore, mobileChange, ...desktop } = p;
        if (!mobile) return [desktop];
        const id = `${p.id}-phone`;
        const phone = { id, title: `${p.title} (phone)`, group: p.group ?? '', device: 'phone', route: p.route ?? '', before: mobileBefore ?? null, beforeLabel: 'before', after: mobile, afterLabel: 'after', note: '', change: mobileChange ?? null };
        const verdict = feedback.verdicts[`${round.n}/${p.id}`];
        if (verdict) feedback.verdicts[`${round.n}/${id}`] = { ...verdict };
        for (const c of feedback.comments) {
          const pins = c.pins ?? (c.pin ? [c.pin] : []);
          if (c.round === round.n && c.page === p.id && pins.length && pins.every((x) => x.img === 'mobile')) {
            c.page = id;
            c.pins = pins.map((x) => ({ ...x, img: 'after' }));
            delete c.pin;
            for (const reply of feedback.comments) if (reply.replyTo === c.id) reply.page = id;
          }
        }
        return [desktop, phone];
      });
    }
    writeJson(join(dir, 'feedback.json'), feedback);
    writeJson(roundsFile, rounds);
  });
}

function cleanPin(pin) {
  if (!pin || !PIN_TARGETS.includes(pin.img)) return null;
  const ok = [pin.x, pin.y].every((n) => typeof n === 'number' && n >= 0 && n <= 100);
  return ok ? { img: pin.img, x: Math.round(pin.x * 10) / 10, y: Math.round(pin.y * 10) / 10 } : null;
}

/** The spots a comment marks, in the order its text numbers them ([1] is the first). */
export const pinsOf = (c) => c.pins ?? (c.pin ? [c.pin] : []);

/** Threads: each top-level comment with its replies, oldest first. */
export function threads(comments) {
  const roots = comments.filter((c) => !c.replyTo);
  return roots.map((root) => ({ ...root, replies: comments.filter((c) => c.replyTo === root.id) }));
}

/** Open threads whose last word is a human's: the ones an agent still has to act on. */
export function needsReply(comments) {
  return threads(comments).filter((t) => t.status !== 'resolved' && [t, ...t.replies].at(-1).kind === 'human');
}
