// Renders the feedback an agent acts on: the reviewer's note, every thread waiting for a reply, and the verdicts.
// The CLI prints it (`feedback`, `wait`) and the app sends it into an agent's chat thread.
import { needsReply, pinsOf, threads } from './store.mjs';

const fmtDate = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const SHOT = { mobile: 'phone', previous: 'last round' };

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
    const pins = pinsOf(t);
    const phone = page?.device === 'phone' ? 'phone ' : '';
    const spot = (pin) => `the ${phone}${SHOT[pin.img] ?? pin.img} screenshot at ${pin.x}% across, ${pin.y}% down`;
    const image = (pin) => {
      const file = pin.img === 'previous' ? rounds.find((x) => x.n === t.round - 1)?.pages.find((p) => p.id === t.page)?.after : page?.[pin.img];
      return file ? store.imagePath(slug, file) : null;
    };
    // An older comment holds one spot and does not name it in its text.
    const single = pins.length === 1 && !t.text.includes('[1]');
    const pinned = !pins.length ? 'general comment' : single ? `pinned on ${spot(pins[0])}` : `marks ${plural(pins.length, 'spot')}, named [1]${pins.length > 1 ? `…[${pins.length}]` : ''} in the text`;
    out.push(`[${t.id}] ${page?.group ? `${page.group.split('/').join(' › ')} › ` : ''}${page?.title ?? t.page} (${t.page}) · round ${t.round} · ${pinned}${t.status === 'resolved' ? ' · resolved' : ''}`);
    if (single && image(pins[0])) out.push(`  image: ${image(pins[0])}`);
    if (!single) pins.forEach((pin, i) => out.push(`  [${i + 1}] on ${spot(pin)}${image(pin) ? ` · image: ${image(pin)}` : ''}`));
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

/**
 * The markers of a round, for an agent whose reviewer talks in a chat: "[3] is too tall" means the spot listed as [3]
 * here. Also which pages the reviewer approved.
 */
export function collectMarkers(store, slug, { round = null } = {}) {
  const { rounds, feedback } = store.get(slug);
  const r = round == null || round === 'latest' ? rounds.at(-1) : rounds.find((x) => x.n === Number(round));
  if (!r) return { round: null, markers: [], approved: [], notApproved: [] };
  const prev = rounds.find((x) => x.n === r.n - 1);
  const markers = feedback.markers.filter((m) => m.round === r.n).sort((a, b) => a.n - b.n).map((m) => {
    const page = r.pages.find((p) => p.id === m.page);
    const file = m.img === 'previous' ? prev?.pages.find((p) => p.id === m.page)?.after : page?.[m.img];
    return { ...m, title: page ? [...(page.group ? page.group.split('/') : []), page.title].join(' › ') : m.page, device: page?.device ?? 'desktop', image: file ? store.imagePath(slug, file) : null };
  });
  const approved = r.pages.filter((p) => feedback.verdicts[`${r.n}/${p.id}`]?.verdict === 'approve').map((p) => p.id);
  return { round: r.n, markers, approved, notApproved: r.pages.map((p) => p.id).filter((id) => !approved.includes(id)) };
}

export function markersText(store, slug, options = {}) {
  const { round, markers, approved, notApproved } = collectMarkers(store, slug, options);
  if (round == null) return `"${slug}" has no rounds yet`;
  const out = [`${plural(markers.length, 'marker')} in "${slug}", round ${round}. The reviewer names them [1], [2], … in the chat.`, ''];
  for (const m of markers) {
    out.push(`[${m.n}] ${m.title} (${m.page}) · the ${m.device === 'phone' ? 'phone ' : ''}${SHOT[m.img] ?? m.img} screenshot at ${m.x}% across, ${m.y}% down`);
    if (m.image) out.push(`    image: ${m.image}`);
  }
  if (markers.length) out.push('');
  out.push(`Approved: ${approved.length} of ${approved.length + notApproved.length} pages${approved.length ? ` (${approved.join(', ')})` : ''}.`);
  return out.join('\n');
}
