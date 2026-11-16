// Stage 4: detect and crop figures/illustrations from page images.
// Ink-density regions are found after masking confident OCR words, then merged
// and filtered. Reads the per-page JSON in the OCR cache; writes crops to the
// figures dir and an index JSON to the cache.
'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const alnumRatio = (s) => {
  const t = s.replace(/\s/g, '');
  if (!t) return 0;
  return ((t.match(/[A-Za-z0-9]/g) || []).length) / t.length;
};
const confident = (w, minConf) => w.conf >= minConf && alnumRatio(w.text) >= 0.4 && w.text.trim().length >= 1;

function comps(flag, gw, gh) {
  const seen = new Uint8Array(flag.length);
  const out = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i0 = y * gw + x;
    if (!flag[i0] || seen[i0]) continue;
    const st = [i0]; seen[i0] = 1;
    let x0 = x, x1 = x, y0 = y, y1 = y, n = 0;
    while (st.length) {
      const i = st.pop(); n++;
      const cx = i % gw, cy = (i / gw) | 0;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        if (flag[j] && !seen[j]) { seen[j] = 1; st.push(j); }
      }
    }
    const CELL = 1; // flag grid already in cells; caller multiplies
    out.push({ x0: x0 * CELL, y0: y0 * CELL, x1: (x1 + 1) * CELL, y1: (y1 + 1) * CELL, cells: n });
  }
  return out;
}

function mergeBoxes(boxes, gap) {
  const res = boxes.slice();
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < res.length; i++) for (let j = i + 1; j < res.length; j++) {
      const a = res[i], b = res[j];
      if (a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1) {
        res[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), cells: a.cells + b.cells };
        res.splice(j, 1); changed = true; break outer;
      }
    }
  }
  return res;
}

async function processPage(jf, pagesDir, cfg, write, outDir) {
  const f = cfg.figures;
  const CELL = f.cell;
  const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
  const g = j.geom;
  const img = path.join(pagesDir, g.file);
  const { data, info } = await sharp(img).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const figures = [];

  for (const half of j.halves) {
    const bx = half.box;
    if (bx.width <= 0 || bx.height <= 0) continue;
    const gw = Math.ceil(bx.width / CELL), gh = Math.ceil(bx.height / CELL);
    const ink = new Int32Array(gw * gh);
    for (let y = 0; y < bx.height; y++) {
      const gy = (y + bx.top) * W + bx.left;
      const cy = (y / CELL) | 0;
      for (let x = 0; x < bx.width; x++) if (data[gy + x] < f.inkThreshold) ink[cy * gw + ((x / CELL) | 0)]++;
    }
    // shadow mask: rows/columns whose mean brightness is low (gutter shadow, scan edges)
    const colBright = new Float64Array(bx.width), rowBright = new Float64Array(bx.height);
    for (let y = 0; y < bx.height; y++) {
      const gy = (y + bx.top) * W + bx.left;
      let s = 0;
      for (let x = 0; x < bx.width; x++) { const v = data[gy + x]; s += v; colBright[x] += v; }
      rowBright[y] = s / bx.width;
    }
    for (let x = 0; x < bx.width; x++) colBright[x] /= bx.height;
    const shadowCol = new Uint8Array(gw);
    for (let c = 0; c < gw; c++) {
      let s = 0, n = 0;
      for (let x = c * CELL; x < Math.min(bx.width, (c + 1) * CELL); x++) { s += colBright[x]; n++; }
      if (s / n < f.shadowBrightness) shadowCol[c] = 1;
    }
    const shadowRow = new Uint8Array(gh);
    for (let r = 0; r < gh; r++) {
      let s = 0, n = 0;
      for (let y = r * CELL; y < Math.min(bx.height, (r + 1) * CELL); y++) { s += rowBright[y]; n++; }
      if (s / n < f.shadowBrightness) shadowRow[r] = 1;
    }
    const covered = new Uint8Array(gw * gh);
    for (const line of half.lines) for (const w of line.words) {
      if (!confident(w, f.wordMinConf)) continue;
      const x0 = Math.max(0, w.bbox.x0 - f.wordPadX), x1 = Math.min(bx.width, w.bbox.x1 + f.wordPadX);
      const y0 = Math.max(0, w.bbox.y0 - f.wordPadTop), y1 = Math.min(bx.height, w.bbox.y1 + f.wordPadBottom);
      for (let cy = (y0 / CELL) | 0; cy <= ((y1 / CELL) | 0); cy++)
        for (let cx = (x0 / CELL) | 0; cx <= ((x1 / CELL) | 0); cx++)
          if (cy >= 0 && cy < gh && cx >= 0 && cx < gw) covered[cy * gw + cx] = 1;
    }
    const flag = new Uint8Array(gw * gh);
    const edgeC = f.edgeCells, edgeR = f.edgeCells;
    for (let r = 0; r < gh; r++) for (let c = 0; c < gw; c++) {
      const i = r * gw + c;
      if (c < edgeC || c >= gw - edgeC || r < edgeR || r >= gh - edgeR) continue;
      if (shadowCol[c] || shadowRow[r]) continue;
      if (covered[i]) continue;
      if (ink[i] / (CELL * CELL) >= f.minInkDensity) flag[i] = 1;
    }
    // comps() works on the cell grid; scale boxes back to pixels
    const cellBoxes = comps(flag, gw, gh).map((b) => ({ x0: b.x0 * CELL, y0: b.y0 * CELL, x1: b.x1 * CELL, y1: b.y1 * CELL, cells: b.cells }));
    let boxes = cellBoxes.filter((b) => {
      const wd = b.x1 - b.x0, ht = b.y1 - b.y0;
      if (wd < f.minW || ht < f.minH || b.cells < f.minCells) return false;
      if (wd * ht < f.minArea) return false;
      if (wd < 55 && ht > 260) return false;   // thin vertical streaks = scan artifacts
      if (ht < 30 && wd > 600) return false;
      if (b.y0 <= 2 * CELL && b.y1 >= (gh - 3) * CELL) return false;
      return true;
    });
    boxes = mergeBoxes(boxes, f.mergeGap1);
    boxes = mergeBoxes(boxes, f.mergeGap2);
    for (const b of boxes) {
      const x0 = Math.max(0, b.x0 - f.cropPadX), y0 = Math.max(0, b.y0 - f.cropPadY);
      const x1 = Math.min(bx.width, b.x1 + f.cropPadX), y1 = Math.min(bx.height, b.y1 + f.cropPadY);
      if (x1 - x0 < f.minW || y1 - y0 < f.minH) continue;
      figures.push({ side: half.side, box: { left: bx.left + x0, top: bx.top + y0, width: x1 - x0, height: y1 - y0 }, rel: { x0, y0, x1, y1 } });
    }
  }
  let k = 0;
  for (const fig of figures) {
    k++;
    const name = `p${String(j.page).padStart(3, '0')}-fig${k}.png`;
    if (write) {
      const buf = await sharp(img).extract(fig.box)
        .resize({ width: Math.min(f.maxUpScale * fig.box.width, f.maxWidthPx), kernel: 'lanczos3' })
        .png({ compressionLevel: 9 }).toBuffer();
      fs.writeFileSync(path.join(outDir, name), buf);
    }
    fig.file = name;
  }
  return { page: j.page, figures };
}

async function run(ocrDir, pagesDir, outDir, indexFile, cfg, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const only = opts.only || null;
  const files = only || fs.readdirSync(ocrDir).filter((x) => /^page-\d+\.json$/.test(x)).sort();
  const all = [];
  for (const x of files) {
    const p = path.join(ocrDir, x);
    if (!fs.existsSync(p)) continue;
    all.push(await processPage(p, pagesDir, cfg, opts.write !== false, outDir));
  }
  fs.writeFileSync(indexFile, JSON.stringify(all));
  return all;
}

module.exports = { run, mergeBoxes };

if (require.main === module) {
  // usage: node src/figures.js <ocrCacheDir> <pagesDir> <figuresDir> <index.json> [configPath]
  run(process.argv[2], process.argv[3], process.argv[4], process.argv[5], require('./config').loadConfig(process.argv[6]))
    .then((all) => console.log('figures done,', all.reduce((s, a) => s + a.figures.length, 0), 'crops'));
}
