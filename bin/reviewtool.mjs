#!/usr/bin/env node
// reviewtool: rounds of before/after screenshots that people comment on and agents answer.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { postLog, renderLog } from '../src/log.mjs';
import { createApp } from '../src/server.mjs';
import { collectFeedback, collectMarkers, feedbackText, markersText } from '../src/feedback.mjs';
import { ReviewError, Store } from '../src/store.mjs';
import { detectTarget, targetLabel } from '../src/targets.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = new Store();
// Settings that outlive a shell: where people open the app (set by "reviewtool tailscale").
const configFile = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'reviewtool', 'config.json');
function readConfig() {
  try {
    return JSON.parse(readFileSync(configFile, 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(patch) {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ ...readConfig(), ...patch }, null, 2) + '\n');
}
// Height over width of the latest round's desktop screenshots: the most common one, as most are captured at one size.
function screenshotRatio(slug) {
  const latest = store.get(slug).rounds.at(-1);
  const counts = new Map();
  for (const p of latest?.pages ?? []) {
    if (p.device === 'phone' || !p.after?.endsWith('.png')) continue;
    try {
      const head = readFileSync(store.imagePath(slug, p.after)).subarray(16, 24); // PNG IHDR: width, height
      const r = Math.round((head.readUInt32BE(4) / head.readUInt32BE(0)) * 1000) / 1000;
      if (r > 0 && r < 3) counts.set(r, (counts.get(r) ?? 0) + 1);
    } catch {}
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0.625;
}
function publicLink(slug, page, { chat = false } = {}) {
  const { publicUrl, publicKey } = readConfig();
  if (!publicUrl || !publicKey) throw new ReviewError('no public link: set one up with "reviewtool relay" (see reviewtool --help)');
  return `${publicUrl}/r/${encodeURIComponent(slug)}?key=${publicKey}${chat ? '&chat=1' : ''}${page ? `#${encodeURIComponent(page)}` : ''}`;
}
const baseUrl = () => (process.env.REVIEWTOOL_URL || readConfig().url || 'http://localhost:4477').replace(/\/$/, '');

// Global skill folders: Claude Code reads ~/.claude/skills; Codex, Pi and OpenCode read ~/.agents/skills
// (OpenCode reads both).
const SKILL_DIRS = [join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills')];

const HELP = `reviewtool — review rounds of before/after screenshots in the browser; agents read the feedback and reply.

Usage:
  reviewtool serve [--port 4477] [--host 127.0.0.1]   start the review app
  reviewtool init <name> [--title T] [--repo owner/name] [--pr N] [--branch B]
  reviewtool set <name> [--title T] [--repo owner/name] [--pr N] [--branch B]
  reviewtool list                                       all reviews
  reviewtool round <name> <manifest.json> [--title T] [--notes N] [--as Claude]
                                                        add the next round (images are copied into the store)
  reviewtool rounds <name>                              list rounds and their pages
  reviewtool group <name> <page-id>... --to <folder> [--round N]
                                                        put pages in a folder ("Settings/Team & access"; "" for none)
  reviewtool wait <name> [--as Claude] [--timeout SECONDS] [--json]
                                                        block until the reviewer presses "Send to agent", then print
                                                        the feedback (exit 0); exit 2 when the timeout passes first
  reviewtool feedback <name> [--all] [--round N] [--json]
                                                        threads waiting for an agent (--all: every open thread)
  reviewtool reply <name> <comment-id> <text> [--as Claude] [--resolve]
  reviewtool comment <name> <page-id> <text> [--round N] [--as Claude]
  reviewtool resolve <name> <comment-id> [--reopen]
  reviewtool log <name> [--post] [--repo owner/name] [--pr N] [--out file]
                                                        the review log as Markdown; --post puts it on the PR
  reviewtool markers <name> [--round N] [--json]          the spots the reviewer marked in the chat view, [1], [2], …,
                                                        with their page and image, and which pages they approved
  reviewtool url <name> [<page-id>] [--public]          link to the review (REVIEWTOOL_URL sets the host);
                                                        --public: the link that works from anywhere, with its key
  reviewtool embed <name> [<page-id>] [--height PX]    HTML that shows the review inside an agent chat (T3 Code)
  reviewtool target <name> [--here | --none]            where "send" delivers feedback: this T3 Code thread
                                                        (--here; automatic for init, round and wait inside T3),
                                                        or nowhere, for agents that use wait (--none)
  reviewtool install-skill [--dir D] [--copy]           install the agent skill for Claude Code (~/.claude/skills)
                                                        and Codex, Pi and OpenCode (~/.agents/skills), as a link
                                                        to this package so updates come along (--copy to copy)
  reviewtool service [--port 4477] [--remove]           run the app as a systemd user service that starts at boot
  reviewtool tailscale [--port 4477] [--https-port 14477]
                                                        open the app to your tailnet with tailscale serve and use that
                                                        address in the links agents print
  reviewtool relay --via user@host --url https://name [--remote-port 4478] [--remove]
                                                        reach the app from the internet through a server you can
                                                        ssh into; every request there needs a secret key

Data lives in ${store.root} (REVIEWTOOL_HOME overrides).
Manifest: { "title"?, "notes"?, "pages": [{ "id", "title", "group"?, "device"?, "route"?, "before"?, "beforeLabel"?,
            "after", "afterLabel"?, "mobile"?, "mobileBefore"?, "note"? }] } — image paths relative to the manifest;
            "group" is a folder like "Settings/Team & access"; "device": "phone" makes a page whose before and
            after are phone screenshots; "mobile"/"mobileBefore" on a desktop page add such a phone page of its
            own, "<id>-phone", right after it. Folders and devices carry over.`;

const OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  title: { type: 'string' },
  repo: { type: 'string' },
  pr: { type: 'string' },
  branch: { type: 'string' },
  notes: { type: 'string' },
  as: { type: 'string' },
  round: { type: 'string' },
  out: { type: 'string' },
  dir: { type: 'string' },
  copy: { type: 'boolean' },
  remove: { type: 'boolean' },
  'https-port': { type: 'string' },
  all: { type: 'boolean' },
  json: { type: 'boolean' },
  post: { type: 'boolean' },
  resolve: { type: 'boolean' },
  reopen: { type: 'boolean' },
  timeout: { type: 'string' },
  here: { type: 'boolean' },
  to: { type: 'string' },
  none: { type: 'boolean' },
  public: { type: 'boolean' },
  via: { type: 'string' },
  url: { type: 'string' },
  height: { type: 'string' },
  'remote-port': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

function need(value, what) {
  if (!value) throw new ReviewError(`missing ${what}; see reviewtool --help`);
  return value;
}

const fmtDate = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const CHANGE_TEXT = { same: 'unchanged', minor: 'barely changed', changed: 'changed', new: 'new', unknown: 'not compared' };

function changeSummary(round) {
  if (!round.pages.some((p) => p.change)) return '';
  const groups = {};
  for (const p of round.pages) (groups[p.change?.status ?? 'unknown'] ??= []).push(p.id);
  return ['changed', 'new', 'minor', 'same', 'unknown'].filter((k) => groups[k]).map((k) => `${groups[k].length} ${CHANGE_TEXT[k]}`).join(', ');
}

function printFeedback(slug, { all = false, round = null, json = false, submission = null } = {}) {
  if (json) {
    const { latest, threads: list, verdicts } = collectFeedback(store, slug, { all, round });
    return console.log(JSON.stringify({ round: latest?.n ?? null, submission, threads: list, verdicts }, null, 2));
  }
  console.log(feedbackText(store, slug, { all, round, submission }));
}

/** Inside T3 Code, link the review to the calling agent's thread so the app sends feedback there. */
function linkThread(slug, agent) {
  const target = detectTarget(process.env, { agent });
  if (!target) return null;
  const current = store.get(slug).review.target;
  if (current?.kind === 't3' && current.thread === target.thread && current.title === target.title && current.agent === (agent ?? current.agent)) return current;
  store.setTarget(slug, { ...target, agent: agent ?? current?.agent ?? null });
  return target;
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const { values: o, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, ...args] = positionals;
  if (o.help || !cmd || cmd === 'help') return console.log(HELP);

  switch (cmd) {
    case 'serve': {
      const port = Number(o.port ?? process.env.PORT ?? 4477);
      const host = o.host ?? '127.0.0.1';
      createApp(store).listen(port, host, () => console.log(`reviewtool on http://${host}:${port} (data: ${store.root})`));
      // The port a relay forwards from the internet: always local, and every request needs the key.
      const { publicKey, publicPort = port + 1 } = readConfig();
      if (publicKey) createApp(store, { key: publicKey }).listen(publicPort, '127.0.0.1', () => console.log(`public side (key required) on http://127.0.0.1:${publicPort}`));
      return;
    }
    case 'init': {
      const slug = need(args[0], 'review name');
      const review = store.create({ slug, title: o.title, repo: o.repo, pr: o.pr, branch: o.branch });
      const target = linkThread(slug, o.as ?? null);
      console.log(`created review "${review.slug}": ${baseUrl()}/r/${slug}${target ? `\nfeedback will be sent to ${targetLabel(target)}` : ''}`);
      return;
    }
    case 'set': {
      const review = store.update(need(args[0], 'review name'), { title: o.title, repo: o.repo, pr: o.pr, branch: o.branch });
      console.log(JSON.stringify(review, null, 2));
      return;
    }
    case 'list': {
      const reviews = store.list();
      if (o.json) return console.log(JSON.stringify(reviews, null, 2));
      if (!reviews.length) return console.log('no reviews yet; start one with: reviewtool init <name>');
      for (const r of reviews) console.log(`${r.slug}\t${r.rounds} rounds\t${r.open} waiting\t${r.title}${r.pr ? `\t${r.repo}#${r.pr}` : ''}`);
      return;
    }
    case 'round': {
      const slug = need(args[0], 'review name');
      const file = resolve(need(args[1], 'manifest file'));
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (o.title) manifest.title = o.title;
      if (o.notes) manifest.notes = o.notes;
      if (o.as) manifest.by = o.as;
      const round = store.addRound(slug, manifest, dirname(file));
      const target = linkThread(slug, o.as ?? null);
      const summary = changeSummary(round);
      console.log(`added round ${round.n} with ${round.pages.length} pages${summary ? ` (${summary} since round ${round.n - 1})` : ''}: ${baseUrl()}/r/${slug}`);
      if (target) console.log(`When the reviewer presses send, their feedback arrives in ${targetLabel(target)} as a new message. End your turn; there is no need to run "reviewtool wait".`);
      return;
    }
    case 'rounds': {
      const { rounds } = store.get(need(args[0], 'review name'));
      if (o.json) return console.log(JSON.stringify(rounds, null, 2));
      for (const r of rounds) {
        console.log(`round ${r.n} · ${r.title} · ${fmtDate(r.createdAt)}${changeSummary(r) ? ` · ${changeSummary(r)}` : ''}`);
        for (const p of r.pages) console.log(`  ${p.group ? `${p.group}/` : ''}${p.id}${p.device === 'phone' ? ' (phone)' : ''}${p.change ? `  ${CHANGE_TEXT[p.change.status]}${p.change.ratio ? ` (${(p.change.ratio * 100).toFixed(1)}%)` : ''}` : ''}`);
      }
      return;
    }
    case 'group': {
      const slug = need(args[0], 'review name');
      const ids = args.slice(1);
      if (!ids.length) throw new ReviewError('name the pages to move; see reviewtool --help');
      if (o.to === undefined) throw new ReviewError('missing --to <folder> (use --to "" to take pages out of their folder)');
      const res = store.setGroup(slug, { round: o.round ?? 'latest', pages: ids, group: o.to });
      console.log(`moved ${res.pages.length} page${res.pages.length === 1 ? '' : 's'} in round ${res.round} ${res.group ? `to "${res.group}"` : 'out of their folder'}`);
      return;
    }
    case 'feedback': {
      printFeedback(need(args[0], 'review name'), { all: o.all, round: o.round, json: o.json });
      return;
    }
    case 'markers': {
      const slug = need(args[0], 'review name');
      console.log(o.json ? JSON.stringify(collectMarkers(store, slug, { round: o.round }), null, 2) : markersText(store, slug, { round: o.round }));
      return;
    }
    case 'wait': {
      const slug = need(args[0], 'review name');
      const by = o.as || 'Claude';
      const timeout = Number(o.timeout ?? 0) * 1000;
      const started = Date.now();
      const stop = (code) => {
        store.setWaiting(slug, null);
        process.exit(code);
      };
      process.on('SIGINT', () => stop(130));
      process.on('SIGTERM', () => stop(143));
      linkThread(slug, by);
      if (!o.json) console.error(`waiting for feedback on "${slug}": ${baseUrl()}/r/${slug}`);
      for (;;) {
        const submission = store.pickUp(slug, by);
        if (submission) {
          store.setWaiting(slug, null);
          printFeedback(slug, { json: o.json, submission });
          return;
        }
        if (timeout && Date.now() - started >= timeout) {
          store.setWaiting(slug, null);
          console.log(`No feedback was sent within ${Math.round(timeout / 1000)} seconds. Run "reviewtool wait ${slug}" again to keep waiting.`);
          process.exit(2);
        }
        store.setWaiting(slug, { by, since: new Date(started).toISOString(), pid: process.pid });
        await sleep(2000);
      }
    }
    case 'reply': {
      const slug = need(args[0], 'review name');
      const id = need(args[1], 'comment id');
      const text = need(args.slice(2).join(' '), 'reply text');
      const c = store.addComment(slug, { replyTo: id, text, author: o.as || 'Claude', kind: 'agent' });
      if (o.resolve) store.setStatus(slug, c.replyTo, 'resolved');
      console.log(`replied to ${c.replyTo}${o.resolve ? ' and resolved it' : ''}`);
      return;
    }
    case 'comment': {
      const slug = need(args[0], 'review name');
      const page = need(args[1], 'page id');
      const c = store.addComment(slug, { round: o.round ?? 'latest', page, text: need(args.slice(2).join(' '), 'text'), author: o.as || 'Claude', kind: 'agent' });
      console.log(`added comment ${c.id} on ${page} (round ${c.round})`);
      return;
    }
    case 'resolve': {
      const c = store.setStatus(need(args[0], 'review name'), need(args[1], 'comment id'), o.reopen ? 'open' : 'resolved');
      console.log(`${c.id} is ${c.status}`);
      return;
    }
    case 'log': {
      const slug = need(args[0], 'review name');
      const data = store.get(slug);
      const md = renderLog(data, { url: process.env.REVIEWTOOL_URL ? `${baseUrl()}/r/${slug}` : null });
      if (o.out) writeFileSync(o.out, md);
      if (o.post) {
        const { action, url } = postLog(md, { repo: o.repo ?? data.review.repo, pr: o.pr ?? data.review.pr });
        console.log(`${action} the review log: ${url}`);
      } else if (!o.out) {
        process.stdout.write(md);
      }
      return;
    }
    case 'url': {
      const slug = need(args[0], 'review name');
      store.mustDir(slug);
      console.log(o.public ? publicLink(slug, args[1]) : `${baseUrl()}/r/${slug}${args[1] ? `#${encodeURIComponent(args[1])}` : ''}`);
      return;
    }
    case 'embed': {
      // A page for an agent's chat to show inline (T3 Code's html_render): the review in a frame, over the public link.
      // The frame is as tall as the review's bars (136px) plus a desktop screenshot at the chat's full width, so
      // the screenshot fills it with nothing empty below, and it keeps that height on every page.
      const slug = need(args[0], 'review name');
      store.mustDir(slug);
      const src = publicLink(slug, args[1], { chat: true }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const ratio = screenshotRatio(slug);
      // Measured against the frame's own box (container units), not the window: the chat may pad its pages. The 1px
      // border sits inside the size (border-box), so the review gets that width minus 2px and 136px more than the
      // screenshot's height at that width, plus the border.
      const height = o.height ? `${Math.min(2000, Math.max(300, Number(o.height)))}px` : `calc(138px + ${ratio} * (100cqw - 2px))`;
      console.log(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.box{container-type:inline-size}iframe{display:block;box-sizing:border-box;width:100%;height:${height};border:1px solid var(--border,#8884);border-radius:var(--radius,8px)}</style></head><body><div class="box"><iframe src="${src}" title="Review" allow="clipboard-write"></iframe></div></body></html>`);
      // T3's reply column is 728px and it pads a page by 8px, so the frame is 712px wide there.
      if (!o.height) console.error(`(html_render height: ${Math.round(16 + 138 + ratio * 710)})`);
      return;
    }
    case 'relay': {
      // Make the app reachable from the public internet through a server you can ssh into, without opening this
      // machine: ssh keeps a reverse tunnel to it, and that server's web server sends a public https name into it.
      const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
      const unit = join(unitDir, 'reviewtool-relay.service');
      const systemctl = (...a) => execFileSync('systemctl', ['--user', ...a], { stdio: 'inherit' });
      if (o.remove) {
        try { systemctl('disable', '--now', 'reviewtool-relay.service'); } catch {}
        rmSync(unit, { force: true });
        systemctl('daemon-reload');
        writeConfig({ publicKey: undefined, publicUrl: undefined, publicPort: undefined });
        console.log('removed the relay; the app is no longer on the public internet');
        return;
      }
      const via = need(o.via, '--via user@host');
      const publicUrl = need(o.url, '--url https://name.example');
      const port = Number(o.port ?? 4477);
      const publicPort = port + 1;
      const remotePort = Number(o['remote-port'] ?? publicPort);
      const config = readConfig();
      const publicKey = config.publicKey ?? randomBytes(24).toString('base64url');
      writeConfig({ publicKey, publicUrl: publicUrl.replace(/\/$/, ''), publicPort });
      const ssh = execFileSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).trim();
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(unit, [
        '[Unit]',
        `Description=reviewtool: reverse tunnel to ${via} for ${publicUrl}`,
        'After=network-online.target reviewtool.service',
        '',
        '[Service]',
        `ExecStart=${ssh} -N -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 127.0.0.1:${remotePort}:127.0.0.1:${publicPort} ${via}`,
        'Restart=always',
        'RestartSec=10',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'));
      systemctl('daemon-reload');
      try { systemctl('restart', 'reviewtool.service'); } catch { console.log('(start the app with "reviewtool service" so it opens the public side)'); }
      systemctl('enable', 'reviewtool-relay.service');
      systemctl('restart', 'reviewtool-relay.service');
      console.log([
        `the tunnel runs as reviewtool-relay.service: ${via} port ${remotePort} (its localhost only) reaches this app's key-only side.`,
        `On ${via.split('@').pop()}, point ${publicUrl} at it, for example with Caddy:`,
        '',
        `  ${new URL(publicUrl).host} {`,
        `    reverse_proxy 127.0.0.1:${remotePort}`,
        '  }',
        '',
        `Links that work from anywhere: reviewtool url <name> --public. In T3 Code: reviewtool embed <name>.`,
      ].join('\n'));
      return;
    }
    case 'target': {
      const slug = need(args[0], 'review name');
      if (o.none) store.setTarget(slug, null);
      else if (o.here) {
        const target = detectTarget(process.env, { agent: o.as ?? null });
        if (!target) throw new ReviewError('not running inside a T3 Code thread (T3CODE_THREAD_ID and T3CODE_CLI_PATH are not set)');
        store.setTarget(slug, target);
      }
      const target = store.get(slug).review.target;
      console.log(target ? `feedback goes to ${targetLabel(target)}${target.link ? ` (${target.link})` : ''}` : 'feedback waits for an agent running "reviewtool wait"');
      return;
    }
    case 'install-skill': {
      const source = join(root, 'skills', 'reviewtool');
      for (const parent of o.dir ? [resolve(o.dir)] : SKILL_DIRS) {
        const dir = join(parent, 'reviewtool');
        mkdirSync(parent, { recursive: true });
        // Replace an earlier install of this skill, never something else that happens to use the name.
        if (existsSync(dir) || isLink(dir)) {
          const ours = isLink(dir) || /^name:\s*reviewtool\s*$/m.test(readFileSafe(join(dir, 'SKILL.md')));
          if (!ours) throw new ReviewError(`${dir} exists and is not the reviewtool skill; move it away first`);
          rmSync(dir, { recursive: true, force: true });
        }
        let how = 'copied';
        if (!o.copy) {
          try {
            symlinkSync(source, dir, 'dir');
            how = 'linked';
          } catch {}
        }
        if (how === 'copied') cpSync(source, dir, { recursive: true });
        console.log(`${how} the reviewtool skill into ${dir}`);
      }
      return;
    }
    case 'service': {
      if (process.platform !== 'linux') throw new ReviewError('reviewtool service sets up a systemd user service, which needs Linux; on other systems run "reviewtool serve" with your own service manager');
      const port = Number(o.port ?? 4477);
      const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
      const unit = join(unitDir, 'reviewtool.service');
      const systemctl = (...a) => execFileSync('systemctl', ['--user', ...a], { stdio: 'inherit' });
      if (o.remove) {
        try { systemctl('disable', '--now', 'reviewtool.service'); } catch {}
        rmSync(unit, { force: true });
        systemctl('daemon-reload');
        console.log('removed the reviewtool service');
        return;
      }
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(unit, [
        '[Unit]',
        'Description=reviewtool: screenshot review rounds',
        'After=network-online.target',
        '',
        '[Service]',
        `ExecStart=${process.execPath} ${join(root, 'bin', 'reviewtool.mjs')} serve --port ${port}`,
        ...(process.env.REVIEWTOOL_HOME ? [`Environment=REVIEWTOOL_HOME=${process.env.REVIEWTOOL_HOME}`] : []),
        'Restart=on-failure',
        'RestartSec=3',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'));
      systemctl('daemon-reload');
      systemctl('enable', 'reviewtool.service');
      systemctl('restart', 'reviewtool.service');
      console.log(`reviewtool runs as a user service on http://127.0.0.1:${port} (${unit}). It starts at boot when user lingering is on: loginctl enable-linger`);
      return;
    }
    case 'tailscale': {
      const port = Number(o.port ?? 4477);
      const httpsPort = Number(o['https-port'] ?? 14477);
      const ts = (...a) => execFileSync('tailscale', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      let host;
      try {
        host = JSON.parse(ts('status', '--json')).Self.DNSName.replace(/\.$/, '');
      } catch (error) {
        throw new ReviewError(`could not read this machine's tailnet name: ${error.stderr?.toString().trim() || error.message}`);
      }
      try {
        ts('serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${port}`);
      } catch (error) {
        throw new ReviewError(`tailscale serve failed: ${error.stderr?.toString().trim() || error.message}\n(if it asks for permission, run once: sudo tailscale set --operator=$USER)`);
      }
      const url = `https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
      writeConfig({ url });
      console.log(`the app is on your tailnet at ${url} (only devices on your tailnet can open it); agents now print links to it`);
      return;
    }
    default:
      throw new ReviewError(`unknown command "${cmd}"; see reviewtool --help`);
  }
}

main().catch((error) => {
  console.error(`reviewtool: ${error.message}`);
  process.exit(1);
});
