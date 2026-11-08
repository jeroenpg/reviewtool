// Screenshot comparison without dependencies: a small PNG decoder and a pixel diff that reports how much changed
// and where, as boxes in percent of the image.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** Decodes a non-interlaced PNG into { width, height, rgba }, or returns null for anything it cannot read. */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let pos = 8;
  let width, height, depth, type, interlace;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (name === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
  }
  if (!width || !height || interlace !== 0 || ![8, 16].includes(depth) && !(type === 3 && depth <= 8)) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) return null;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < (stride + 1) * height) return null;
  const lines = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = lines.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      out[i] = v & 255;
    }
    prev = out;
  }
  const rgba = new Uint8Array(width * height * 4);
  const sample = (line, x, ch) => {
    if (depth === 16) return line[(x * channels + ch) * 2];
    if (depth === 8) return line[x * channels + ch];
    const bit = x * depth;
    return (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  for (let y = 0; y < height; y++) {
    const line = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (type === 3) {
        const i = sample(line, x, 0);
        rgba[o] = palette?.[i * 3] ?? 0;
        rgba[o + 1] = palette?.[i * 3 + 1] ?? 0;
        rgba[o + 2] = palette?.[i * 3 + 2] ?? 0;
        rgba[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (type === 0 || type === 4) {
        const g = sample(line, x, 0);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = type === 4 ? sample(line, x, 1) : 255;
      } else {
        rgba[o] = sample(line, x, 0);
        rgba[o + 1] = sample(line, x, 1);
        rgba[o + 2] = sample(line, x, 2);
        rgba[o + 3] = type === 6 ? sample(line, x, 3) : 255;
      }
    }
  }
  return { width, height, rgba };
}

const THRESHOLD = 24; // per-channel difference that counts as a change; ignores anti-aliasing noise
// A minor change is a speck: under 0.03% of the pixels, in small areas only (a clock, a cursor, a counter). Anything
// bigger is a change, however few pixels it touches; a moved button is small too.
const MINOR_RATIO = 0.0003;
const MINOR_AREA = 0.25; // percent of the image a single minor area may cover
const MAX_BOXES = 24;

/**
 * Compares two screenshots. Returns { status, ratio, boxes, size } where status is
 * "same" (identical), "minor" (a sliver changed), "changed", or "unknown" (could not decode).
 */
export function compareImages(fileA, fileB) {
  const a = readFileSync(fileA);
  const b = readFileSync(fileB);
  if (a.equals(b)) return { status: 'same', ratio: 0, boxes: [] };
  const ia = decodePng(a);
  const ib = decodePng(b);
  if (!ia || !ib) return { status: 'unknown', ratio: null, boxes: [] };
  if (ia.width !== ib.width || ia.height !== ib.height) {
    return { status: 'changed', ratio: 1, boxes: [], size: { from: [ia.width, ia.height], to: [ib.width, ib.height] } };
  }
  const { width, height } = ib;
  const cell = Math.max(8, Math.round(width / 96));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const grid = new Uint8Array(cols * rows);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (
        Math.abs(ia.rgba[o] - ib.rgba[o]) > THRESHOLD ||
        Math.abs(ia.rgba[o + 1] - ib.rgba[o + 1]) > THRESHOLD ||
        Math.abs(ia.rgba[o + 2] - ib.rgba[o + 2]) > THRESHOLD ||
        Math.abs(ia.rgba[o + 3] - ib.rgba[o + 3]) > THRESHOLD
      ) {
        changed++;
        grid[Math.floor(y / cell) * cols + Math.floor(x / cell)] = 1;
      }
    }
  }
  const ratio = changed / (width * height);
  if (changed === 0) return { status: 'same', ratio: 0, boxes: [] };
  const boxes = regions(grid, cols, rows).map(([c0, r0, c1, r1]) => ({
    x: round1(((c0 * cell) / width) * 100),
    y: round1(((r0 * cell) / height) * 100),
    w: round1((Math.min(width, (c1 + 1) * cell) - c0 * cell) / width * 100),
    h: round1((Math.min(height, (r1 + 1) * cell) - r0 * cell) / height * 100),
  }));
  const minor = ratio < MINOR_RATIO && boxes.every((b) => (b.w * b.h) / 100 < MINOR_AREA);
  return { status: minor ? 'minor' : 'changed', ratio: Math.round(ratio * 100000) / 100000, boxes };
}

const round1 = (n) => Math.round(n * 10) / 10;

// Groups changed cells into rectangles: cells within one cell of each other join the same region.
function regions(grid, cols, rows) {
  const seen = new Uint8Array(grid.length);
  const found = [];
  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || seen[start]) continue;
    let c0 = cols, r0 = rows, c1 = -1, r1 = -1, size = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const c = i % cols, r = (i / cols) | 0;
      size++;
      if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const j = nr * cols + nc;
        if (grid[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    found.push({ box: [c0, r0, c1, r1], size });
  }
  found.sort((x, y) => y.size - x.size);
  if (found.length <= MAX_BOXES) return found.map((f) => f.box);
  // Too many: keep the largest, fold the rest into one box around them.
  const rest = found.slice(MAX_BOXES - 1).map((f) => f.box);
  const merged = rest.reduce((m, b) => [Math.min(m[0], b[0]), Math.min(m[1], b[1]), Math.max(m[2], b[2]), Math.max(m[3], b[3])]);
  return [...found.slice(0, MAX_BOXES - 1).map((f) => f.box), merged];
}
