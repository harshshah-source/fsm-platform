// Pixel-diff the current captures against the committed self-baseline (FE-00 regression guard).
//
//   node visual/compare.mjs
//
// For each visual/current/<name>.png it diffs against visual/baseline/<name>.png with pixelmatch,
// writes visual/diff/<name>.png, and prints + writes visual/report.md with the mismatch ratio.
// NOTE: this is a self-baseline regression check (guards against my own edits drifting). The v2
// reference screenshots stay the human parity target — they use different seed data, so they are
// reviewed by eye, not pixel-matched here. Volatile bands (freshness timestamp / live SLA clocks) are
// masked out so self-diffs are meaningful.

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CURRENT = join(HERE, 'current');
const BASELINE = join(HERE, 'baseline');
const DIFF = join(HERE, 'diff');
mkdirSync(DIFF, { recursive: true });

// Rectangles (in captured px) zeroed on both images before diffing — volatile, data-driven regions.
// Kept intentionally small; extend per-page if a live clock/timestamp shows up as noise.
const MASKS = {
  // e.g. '01-dashboard-zm': [{ x: 900, y: 130, w: 300, h: 24 }],
};

const THRESHOLD = 0.1; // pixelmatch per-pixel colour tolerance
const FAIL_RATIO = 0.02; // >2% changed pixels (after masking) = regression to review

function load(path) {
  return PNG.sync.read(readFileSync(path));
}

function applyMasks(png, rects) {
  for (const { x, y, w, h } of rects ?? []) {
    for (let row = y; row < Math.min(y + h, png.height); row++) {
      for (let col = x; col < Math.min(x + w, png.width); col++) {
        const i = (png.width * row + col) << 2;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = 0;
        png.data[i + 3] = 255;
      }
    }
  }
}

const rows = [];
const names = readdirSync(CURRENT)
  .filter((f) => f.endsWith('.png'))
  .sort();

for (const file of names) {
  const name = file.replace(/\.png$/, '');
  const curPath = join(CURRENT, file);
  const basePath = join(BASELINE, file);

  if (!existsSync(basePath)) {
    rows.push({ name, status: 'NEW', ratio: null });
    continue;
  }

  const cur = load(curPath);
  const base = load(basePath);
  const width = Math.min(cur.width, base.width);
  const height = Math.min(cur.height, base.height);

  // Crop both to the common area (full-page heights drift with data volume).
  const a = cropTo(base, width, height);
  const b = cropTo(cur, width, height);
  applyMasks(a, MASKS[name]);
  applyMasks(b, MASKS[name]);

  const diff = new PNG({ width, height });
  const changed = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: THRESHOLD });
  const ratio = changed / (width * height);
  writeFileSync(join(DIFF, file), PNG.sync.write(diff));
  rows.push({
    name,
    status: ratio > FAIL_RATIO ? 'REVIEW' : 'ok',
    ratio,
    sizeDrift: cur.height !== base.height ? `${base.height}→${cur.height}px` : '',
  });
}

function cropTo(src, width, height) {
  if (src.width === width && src.height === height) return src;
  const out = new PNG({ width, height });
  PNG.bitblt(src, out, 0, 0, width, height, 0, 0);
  return out;
}

const lines = [
  '# Visual self-baseline diff report',
  '',
  '| Screen | Status | Changed % | Height drift |',
  '|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.name} | ${r.status} | ${r.ratio == null ? '—' : (r.ratio * 100).toFixed(2) + '%'} | ${r.sizeDrift || ''} |`,
  ),
];
const report = lines.join('\n') + '\n';
writeFileSync(join(HERE, 'report.md'), report);
console.log(report);

const review = rows.filter((r) => r.status === 'REVIEW');
if (review.length) {
  console.log(`\n${review.length} screen(s) exceed ${FAIL_RATIO * 100}% — review visual/diff/*.png`);
  process.exitCode = 1;
}
