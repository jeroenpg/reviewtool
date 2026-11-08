#!/usr/bin/env node
// reviewtool: rounds of before/after screenshots that people comment on and agents answer.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { postLog, renderLog } from '../src/log.mjs';
import { createApp } from '../src/server.mjs';
import { collectFeedback, feedbackText } from '../src/feedback.mjs';
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
  reviewtool url <name> [<page-id>]                     link to the review (REVIEWTOOL_URL sets the host)
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

Data lives in ${store.root} (REVIEWTOOL_HOME overrides).
Manifest: { "title"?, "notes"?, "pages": [{ "id", "title", "group"?, "device"?, "route"?, "before"?, "beforeLabel"?,
            "after", "afterLabel"?, "mobile"?, "mobileBefore"?, "note"? }] } — image paths relative to the manifest;
            "group" is a folder like "Settings/Team & access"; "mobile"/"mobileBefore" add phone variants to a
            desktop page, "device": "phone" makes a page whose before and after are phone screenshots. Both carry over.`;

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
  help: { type: 'boolean', short: 'h' },
};

function need(value, what) {
  if (!value) throw new ReviewError(`missing ${what}; see reviewtool --help`);
  return value;
}

const fmtDate = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function printThread(t, rounds, slug) {
  const round = rounds.find((r) => r.n === t.round);
  const page = round?.pages.find((p) => p.id === t.page);
  const pinned = t.pin ? `pinned on the ${t.pin.img} screenshot at ${t.pin.x}% across, ${t.pin.y}% down` : 'general comment';
  console.log(`[${t.id}] ${page?.title ?? t.page} (${t.page}) · round ${t.round} · ${pinned}${t.status === 'resolved' ? ' · resolved' : ''}`);
  if (t.pin && page) {
    const file = t.pin.img === 'previous' ? rounds.find((r) => r.n === t.round - 1)?.pages.find((p) => p.id === t.page)?.after : page[t.pin.img];
    if (file) console.log(`  image: ${store.imagePath(slug, file)}`);
  }
  for (const m of [t, ...t.replies]) {
    const lines = m.text.split('\n');
    console.log(`  ${m.author}${m.kind === 'agent' ? ' (agent)' : ''}, ${fmtDate(m.at)}: ${lines[0]}`);
    for (const line of lines.slice(1)) console.log(`    ${line}`);
  }
  console.log('');
}

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
        for (const p of r.pages) console.log(`  ${p.group ? `${p.group}/` : ''}${p.id}${p.device === 'phone' ? ' (phone)' : p.mobile ? ' (+ phone)' : ''}${p.change ? `  ${CHANGE_TEXT[p.change.status]}${p.change.ratio ? ` (${(p.change.ratio * 100).toFixed(1)}%)` : ''}` : ''}`);
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
      console.log(`${baseUrl()}/r/${slug}${args[1] ? `#${encodeURIComponent(args[1])}` : ''}`);
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
