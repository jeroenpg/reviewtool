#!/usr/bin/env node
// reviewtool: rounds of before/after screenshots that people comment on and agents answer.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { postLog, renderLog } from '../src/log.mjs';
import { createApp } from '../src/server.mjs';
import { ReviewError, Store, needsReply, threads } from '../src/store.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = new Store();
const baseUrl = () => (process.env.REVIEWTOOL_URL || 'http://localhost:4477').replace(/\/$/, '');

const HELP = `reviewtool — review rounds of before/after screenshots in the browser; agents read the feedback and reply.

Usage:
  reviewtool serve [--port 4477] [--host 127.0.0.1]   start the review app
  reviewtool init <name> [--title T] [--repo owner/name] [--pr N] [--branch B]
  reviewtool set <name> [--title T] [--repo owner/name] [--pr N] [--branch B]
  reviewtool list                                       all reviews
  reviewtool round <name> <manifest.json> [--title T] [--notes N] [--as Claude]
                                                        add the next round (images are copied into the store)
  reviewtool rounds <name>                              list rounds and their pages
  reviewtool feedback <name> [--all] [--round N] [--json]
                                                        threads waiting for an agent (--all: every open thread)
  reviewtool reply <name> <comment-id> <text> [--as Claude] [--resolve]
  reviewtool comment <name> <page-id> <text> [--round N] [--as Claude]
  reviewtool resolve <name> <comment-id> [--reopen]
  reviewtool log <name> [--post] [--repo owner/name] [--pr N] [--out file]
                                                        the review log as Markdown; --post puts it on the PR
  reviewtool url <name> [<page-id>]                     link to the review (REVIEWTOOL_URL sets the host)
  reviewtool install-skill [--dir ~/.claude/skills]     install the agent skill

Data lives in ${store.root} (REVIEWTOOL_HOME overrides).
Manifest: { "title"?, "notes"?, "pages": [{ "id", "title", "route"?, "before"?, "beforeLabel"?, "after",
            "afterLabel"?, "mobile"?, "mobileBefore"?, "note"? }] } — image paths relative to the manifest.`;

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
  all: { type: 'boolean' },
  json: { type: 'boolean' },
  post: { type: 'boolean' },
  resolve: { type: 'boolean' },
  reopen: { type: 'boolean' },
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
      console.log(`created review "${review.slug}": ${baseUrl()}/r/${slug}`);
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
      console.log(`added round ${round.n} with ${round.pages.length} pages: ${baseUrl()}/r/${slug}`);
      return;
    }
    case 'rounds': {
      const { rounds } = store.get(need(args[0], 'review name'));
      if (o.json) return console.log(JSON.stringify(rounds, null, 2));
      for (const r of rounds) console.log(`round ${r.n} · ${r.title} · ${fmtDate(r.createdAt)} · ${r.pages.map((p) => p.id).join(', ')}`);
      return;
    }
    case 'feedback': {
      const slug = need(args[0], 'review name');
      const { rounds, feedback } = store.get(slug);
      let list = o.all ? threads(feedback.comments).filter((t) => t.status !== 'resolved') : needsReply(feedback.comments);
      if (o.round) list = list.filter((t) => t.round === (o.round === 'latest' ? rounds.at(-1)?.n : Number(o.round)));
      const latest = rounds.at(-1);
      const verdicts = latest ? latest.pages.map((p) => ({ page: p.id, verdict: feedback.verdicts[`${latest.n}/${p.id}`]?.verdict ?? null })) : [];
      if (o.json) return console.log(JSON.stringify({ round: latest?.n ?? null, threads: list, verdicts }, null, 2));
      console.log(`${list.length} thread${list.length === 1 ? '' : 's'} ${o.all ? 'open' : 'waiting for a reply'} in "${slug}"\n`);
      for (const t of list) printThread(t, rounds, slug);
      if (latest) {
        const by = (v) => verdicts.filter((x) => x.verdict === v).map((x) => x.page);
        console.log(`Verdicts in round ${latest.n}: approved ${by('approve').length}, needs update ${by('update').length}${by('update').length ? ` (${by('update').join(', ')})` : ''}, revert ${by('revert').length}${by('revert').length ? ` (${by('revert').join(', ')})` : ''}, none ${by(null).length}`);
      }
      return;
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
    case 'install-skill': {
      const dir = resolve(o.dir ?? join(homedir(), '.claude', 'skills'), 'reviewtool');
      mkdirSync(dir, { recursive: true });
      cpSync(join(root, 'skills', 'reviewtool'), dir, { recursive: true });
      console.log(`installed the reviewtool skill in ${dir}${existsSync(join(dir, 'SKILL.md')) ? '' : ' (SKILL.md missing!)'}`);
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
