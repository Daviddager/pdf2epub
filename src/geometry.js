// Stage 2: page geometry. For each rasterized page: content bounding box and,
// for two-up spreads, the gutter column between the two book pages.
'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function grayRaw(file) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// Analyze one page. Returns geometry record; `spread` pages get a gutter column.
function analyzePage({ data, w, h }, cfg, forceSingle) {
  const g = cfg.geometry;
  const TH = g.inkThreshold;
  const colInk = new Int32Array(w);
  const mx = Math.round(w * g.marginTrim), my = Math.round(h * g.marginTrim);
  for (let y = my; y < h - my; y++) {
    const row = y * w;
    for (let x = mx; x < w - mx; x++) if (data[row + x] < TH) colInk[x]++;
  }
  let left = -1, right = -1;
  for (let x = mx; x < w - mx; x++) if (colInk[x] > h * g.contentInkRatio) { left = x; break; }
  for (let x = w - mx - 1; x >= mx; x--) if (colInk[x] > h * g.contentInkRatio) { right = x; break; }

  const rowink = new Int32Array(h);
  for (let y = my; y < h - my; y++) {
    const row = y * w;
    let c = 0;
    for (let x = mx; x < w - mx; x++) if (data[row + x] < TH) c++;
    rowink[y] = c;
  }
  let top = -1, bot = -1;
  for (let y = my; y < h - my; y++) if (rowink[y] > w * g.contentInkRatio) { top = y; break; }
  for (let y = h - my - 1; y >= my; y--) if (rowink[y] > w * g.contentInkRatio) { bot = y; break; }

  const mid = Math.round(w / 2);
  const band = Math.round(w * g.gutterBand);
  // smoothed (7-column) ink minimum inside the centre band = the gutter
  const sm = (x) => { let s = 0; const n = g.gutterSmooth; const half = (n - 1) / 2; for (let i = -half; i <= half; i++) s += colInk[x + i] || 0; return s / n; };
  let bestS = null;
  for (let x = mid - band; x <= mid + band; x++) {
    const s = sm(x);
    if (!bestS || s < bestS.score) bestS = { x, score: s };
  }
  const spread = !forceSingle && (right - left) > w * cfg.detect.spreadWidthRatio && w / h > cfg.detect.spreadAspect;

  // Refine the gutter: the centre of the widest text-free vertical band near
  // the horizontal centre of the printed content. Robust to blank pages,
  // two-column pages and binding shadows (ported from the original gutter2 pass).
  let gutter = bestS ? bestS.x : mid;
  let gutterBand = null;
  {
    const y0 = Math.max(0, top), y1 = Math.min(h, bot);
    const ink = new Uint16Array(w);
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) if (data[row + x] < TH) ink[x]++;
    }
    const H2 = Math.max(1, y1 - y0);
    const center = (left + right) / 2;
    const bands = [];
    let s = -1;
    for (let x = 0; x < w; x++) {
      const blank = ink[x] <= Math.max(1, H2 * 0.0015);
      if (blank && s < 0) s = x;
      if ((!blank || x === w - 1) && s >= 0) {
        const e = blank ? x : x - 1;
        if (e - s + 1 >= 16) bands.push({ a: s, b: e, c: (s + e) / 2, w: e - s + 1 });
        s = -1;
      }
    }
    bands.sort((p, q) => Math.abs(p.c - center) - Math.abs(q.c - center));
    const best = bands.find((b) => Math.abs(b.c - center) < w * 0.12) || null;
    if (best) { gutter = Math.round(best.c); gutterBand = [best.a, best.b]; }
    else if (Number.isFinite(center)) gutter = Math.round(center);
  }

  return {
    w, h, left, right, top, bot, mid,
    gutter,
    gutterBand,
    gutterScore: bestS ? bestS.score : 0,
    spread,
    mode: spread ? 'spread' : 'single',
  };
}

async function analyze(pagesDir, cfg, opts = {}) {
  const ext = opts.ext || (cfg.raster.format === 'jpeg' ? 'jpg' : cfg.raster.format);
  const prefix = opts.prefix !== undefined ? opts.prefix : 'page-';
  const files = fs.readdirSync(pagesDir).filter((f) => f.startsWith(prefix) && f.endsWith('.' + ext)).sort();
  const out = [];
  for (const f of files) {
    const raw = await grayRaw(path.join(pagesDir, f));
    out.push({ file: f, page: out.length + 1, ...analyzePage(raw, cfg, !!opts.forceSingle) });
  }
  return out;
}

module.exports = { analyze, analyzePage };

if (require.main === module) {
  // usage: node src/geometry.js <pagesDir> [configPath]
  analyze(process.argv[2], require('./config').loadConfig(process.argv[3])).then((geom) => {
    console.log('pages', geom.length);
    console.log(geom.slice(0, 8).map((o) =>
      `${o.page}: L${o.left} R${o.right} T${o.top} B${o.bot} ${o.mode} gut${o.gutter}(${o.gutterScore.toFixed(1)})`).join('\n'));
  });
}
