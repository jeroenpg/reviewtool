// Markers in a comment. Clicking a screenshot marks a spot, and the comment names it as [1], [2], … where it means it.
// Shared by the review page and the long view (window.Marks); pure functions on the comment's text.
(() => {
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

  /* Dictation (Wispr Flow, a phone keyboard) puts in a whole phrase at once, after the clicks made while speaking. A
     marker clicked since the reviewer last typed by hand moves to where that phrase says its number: "this card two"
     or "this card 2" becomes "this card [2]". Dutch works too; "een" only as "nummer een" or "punt een", since it is
     also the word "a". */
  const EN = ',one,two,three,four,five,six,seven,eight,nine,ten,eleven,twelve,thirteen,fourteen,fifteen,sixteen,seventeen,eighteen,nineteen,twenty'.split(',');
  const NL = ',één,twee,drie,vier,vijf,zes,zeven,acht,negen,tien,elf,twaalf,dertien,veertien,vijftien,zestien,zeventien,achttien,negentien,twintig'.split(',');
  const PREFIX = '(?:(?:marker|spot|point|pin|number|nummer|punt|plek)\\s+|#)';
  function spokenNumber(n) {
    const words = [String(n), EN[n], NL[n]].filter(Boolean).join('|');
    const een = n === 1 ? `|${PREFIX}een` : '';
    const num = `(?:${PREFIX}?(?:${words})${een})`;
    // "(1)" as a whole, so it does not end up as "([1])".
    return new RegExp(`\\(${num}\\)|(?<![\\p{L}\\p{N}\\[#])${num}(?![\\p{L}\\p{N}\\]%])`, 'iu');
  }

  /**
   * The box went from `before` to `after` in one input. Returns { handTyped } when one character was typed (the
   * waiting markers then stay where they are), { value, caret, placed } when inserted text said the number of a
   * waiting marker, or null.
   */
  function placeSpoken(before, after, waiting) {
    let p = 0;
    while (p < before.length && p < after.length && before[p] === after[p]) p++;
    let e = 0;
    while (e < before.length - p && e < after.length - p && before.at(-1 - e) === after.at(-1 - e)) e++;
    let chunk = after.slice(p, after.length - e);
    if (chunk.length === 1) return { handTyped: true };
    if (chunk.length < 2 || !waiting.length) return null;
    let head = after.slice(0, p);
    let tail = after.slice(after.length - e);
    const placed = waiting.filter((n) => spokenNumber(n).test(chunk));
    if (!placed.length) return null;
    for (const n of placed) {
      chunk = chunk.replace(spokenNumber(n), `[${n}]`);
      const old = new RegExp(`\\[${n}\\] ?`);
      head = head.replace(old, '');
      tail = tail.replace(old, '');
    }
    if (head && !/\s$/.test(head) && !/^\s/.test(chunk)) head += ' ';
    return { value: head + chunk + tail, caret: (head + chunk).length, placed };
  }

  /** Put [n] into the text at the cursor, with spaces around it. */
  function insertToken(text, at, n) {
    const head = text.slice(0, at);
    const tail = text.slice(at);
    const token = `${head && !/\s$/.test(head) ? ' ' : ''}[${n}]${/^\s/.test(tail) ? '' : ' '}`;
    return { value: head + token + tail, caret: (head + token).length };
  }

  const removeToken = (text, n) => text.replace(new RegExp(` ?\\[${n}\\]`, 'g'), '');

  /** What gets posted: markers renumbered 1, 2, … in the order the text names them; markers it no longer names dropped. */
  function forPosting(text, pins) {
    const order = [];
    for (const [, k] of text.matchAll(/\[(\d+)\]/g)) if (pins.some((x) => x.n === Number(k)) && !order.includes(Number(k))) order.push(Number(k));
    return {
      text: text.trim().replace(/\[(\d+)\]/g, (all, k) => (order.includes(Number(k)) ? `[${order.indexOf(Number(k)) + 1}]` : all)),
      pins: order.map((k) => { const { img, x, y } = pins.find((m) => m.n === k); return { img, x, y }; }),
    };
  }

  const pinsOf = (c) => c.pins ?? (c.pin ? [c.pin] : []);
  // A thread's markers read as its number, with a letter when it marks more than one spot: 3, or 3a and 3b.
  const label = (t, n, k) => `${n ?? ''}${pinsOf(t).length > 1 ? LETTERS[k - 1] : n == null ? k : ''}`;

  window.Marks = { placeSpoken, insertToken, removeToken, forPosting, pinsOf, label };
})();
