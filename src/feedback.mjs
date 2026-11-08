// Renders the feedback an agent acts on: the reviewer's note, every thread waiting for a reply, and the verdicts.
// The CLI prints it (`feedback`, `wait`) and the app sends it into an agent's chat thread.
import { needsReply, threads } from './store.mjs';

const fmtDate = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function collectFeedback(store, slug, { all = false, round = null } = {}) {
  const { review, rounds, feedback } = store.get(slug);
  let list = all ? threads(feedback.comments).filter((t) => t.status !== 'resolved') : needsReply(feedback.comments);
  if (round) list = list.filter((t) => t.round === (round === 'latest' ? rounds.at(-1)?.n : Number(round)));
  const latest = rounds.at(-1);
  const verdicts = latest ? latest.pages.map((p) => ({ page: p.id, verdict: feedback.verdicts[`${latest.n}/${p.id}`]?.verdict ?? null })) : [];
  return { review, rounds, latest, threads: list, verdicts };
}

export function feedbackText(store, slug, { all = false, round = null, submission = null } = {}) {
  const { rounds, latest, threads: list, verdicts } = collectFeedback(store, slug, { all, round });
  const out = [];
  if (submission) {
    out.push(`Feedback sent${submission.by ? ` by ${submission.by}` : ''} at ${fmtDate(submission.at)} for round ${submission.round}: ${plural(submission.comments, 'new comment')}, ${plural(submission.verdicts, 'verdict')}.`);
    if (submission.note) out.push(`Note from the reviewer:\n  ${submission.note.split('\n').join('\n  ')}`);
    out.push('');
  }
  out.push(`${plural(list.length, 'thread')} ${all ? 'open' : 'waiting for a reply'} in "${slug}"`, '');
  for (const t of list) {
    const r = rounds.find((x) => x.n === t.round);
    const page = r?.pages.find((p) => p.id === t.page);
    const shot = { mobile: 'phone', previous: 'last round' }[t.pin?.img] ?? t.pin?.img;
    const pinned = t.pin ? `pinned on the ${page?.device === 'phone' ? 'phone ' : ''}${shot} screenshot at ${t.pin.x}% across, ${t.pin.y}% down` : 'general comment';
    out.push(`[${t.id}] ${page?.group ? `${page.group.split('/').join(' › ')} › ` : ''}${page?.title ?? t.page} (${t.page}) · round ${t.round} · ${pinned}${t.status === 'resolved' ? ' · resolved' : ''}`);
    if (t.pin && page) {
      const file = t.pin.img === 'previous' ? rounds.find((x) => x.n === t.round - 1)?.pages.find((p) => p.id === t.page)?.after : page[t.pin.img];
      if (file) out.push(`  image: ${store.imagePath(slug, file)}`);
    }
    for (const m of [t, ...t.replies]) {
      const lines = m.text.split('\n');
      out.push(`  ${m.author}${m.kind === 'agent' ? ' (agent)' : ''}, ${fmtDate(m.at)}: ${lines[0]}`);
      for (const line of lines.slice(1)) out.push(`    ${line}`);
    }
    out.push('');
  }
  if (latest) {
    const by = (v) => verdicts.filter((x) => x.verdict === v).map((x) => x.page);
    const named = (v) => (by(v).length ? ` (${by(v).join(', ')})` : '');
    out.push(`Verdicts in round ${latest.n}: approved ${by('approve').length}, needs update ${by('update').length}${named('update')}, revert ${by('revert').length}${named('revert')}, none ${by(null).length}`);
  }
  return out.join('\n');
}

/** The message an agent's chat thread receives: self-contained, so the agent knows what it is and what to do. */
export function feedbackMessage(store, slug, submission) {
  const { review } = store.get(slug);
  return [
    `Review feedback for "${review.title}" (reviewtool review "${slug}", round ${submission.round}).`,
    '',
    feedbackText(store, slug, { submission }),
    '',
    `Next: fix what the threads and verdicts ask, reply to every thread with \`reviewtool reply ${slug} <id> "..." --as <your name>\`, then capture new screenshots and publish the next round with \`reviewtool round ${slug} <manifest.json>\`. The reviewtool skill has the details.`,
  ].join('\n');
}
