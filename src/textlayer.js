// Stage 3b: text-layer extraction. For PDFs that already carry real text we
// skip OCR entirely: `pdftotext -bbox-layout` gives words with coordinates,
// which we convert into the same per-half JSON shape the OCR stage produces
// (word/line boxes relative to each half's crop, confidence 100).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { halvesOf } = require('./halves');

function runPdftotextBbox(pdf) {
  const out = os.tmpdir() + '/pdf2epub-bbox-' + path.basename(pdf) + '.html';
  execFileSync('pdftotext', ['-bbox-layout', pdf, out], { maxBuffer: 256 * 1024 * 1024 });
  return fs.readFileSync(out, 'utf8');
}

function parsePages(html) {
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g;
  let m;
  while ((m = pageRe.exec(html))) {
    const lines = [];
    const lineRe = /<line[^>]*>([\s\S]*?)<\/line>/g;
    let lm;
    while ((lm = lineRe.exec(m[3]))) {
      const words = [];
      const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"[^>]*>([\s\S]*?)<\/word>/g;
      let wm;
      while ((wm = wordRe.exec(lm[1]))) {
        words.push({
          text: wm[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, "'"),
          conf: 100,
          bbox: { x0: +wm[1], y0: +wm[2], x1: +wm[3], y1: +wm[4] },
        });
      }
      if (words.length) lines.push({ words });
    }
    pages.push({ w: +m[1], h: +m[2], lines });
  }
  return pages;
}

// Convert one PDF page's point-space words into half-relative pixel-space lines.
function linesForHalves(pdfPage, geom, halves, scale) {
  const absWords = [];
  for (const l of pdfPage.lines) {
    for (const w of l.words) {
      absWords.push({ ...w, cx: (w.bbox.x0 + w.bbox.x1) / 2 * scale, cy: (w.bbox.y0 + w.bbox.y1) / 2 * scale });
    }
  }
  const out = [];
  for (const half of halves) {
    const b = half.box;
    const inBox = (w) => w.cx >= b.left - 2 && w.cx <= b.left + b.width + 2;
    // group absolute words into lines again, restricted to this half
    const mine = absWords.filter(inBox).sort((a, z) => a.cy - z.cy || a.cx - z.cx);
    const rows = [];
    for (const w of mine) {
      const prev = rows[rows.length - 1];
      if (prev && Math.abs(w.cy - prev.cy) < (w.bbox.y1 - w.bbox.y0) * scale * 0.7) prev.words.push(w);
      else rows.push({ cy: w.cy, words: [w] });
    }
    for (const r of rows) {
      const ws = r.words.sort((a, z) => a.cx - z.cx).map((w) => ({
        text: w.text,
        conf: 100,
        bbox: {
          x0: Math.round(w.bbox.x0 * scale - b.left),
          y0: Math.round(w.bbox.y0 * scale - b.top),
          x1: Math.round(w.bbox.x1 * scale - b.left),
          y1: Math.round(w.bbox.y1 * scale - b.top),
        },
      }));
      out.push({
        side: half.side,
        box: b,
        lines: [{
          text: ws.map((w) => w.text).join(' ') + '\n',
          conf: 100,
          bbox: {
            x0: Math.min(...ws.map((w) => w.bbox.x0)), x1: Math.max(...ws.map((w) => w.bbox.x1)),
            y0: Math.min(...ws.map((w) => w.bbox.y0)), y1: Math.max(...ws.map((w) => w.bbox.y1)),
          },
          words: ws,
        }],
      });
    }
  }
  return out;
}

function extract(pdf, geom, cacheDir, cfg, opts = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const sizes = opts.sizes || [];
  const html = runPdftotextBbox(pdf);
  const pdfPages = parsePages(html);
  let count = 0;
  for (let p = 1; p <= geom.length; p++) {
    const outFile = path.join(cacheDir, `page-${String(p).padStart(3, '0')}.json`);
    if (fs.existsSync(outFile) && !opts.overwrite) { count++; continue; }
    const g = geom[p - 1];
    const halves = halvesOf(g);
    const pdfPage = pdfPages[p - 1];
    if (!pdfPage) { fs.writeFileSync(outFile, JSON.stringify({ page: p, geom: { ...g, file: g.file }, halves: [] })); count++; continue; }
    const size = sizes[p - 1] || { w: pdfPage.w, h: pdfPage.h };
    const scale = size.w ? g.w / size.w : cfg.raster.dpi / 72;
    const halfObjs = linesForHalves(pdfPage, g, halves, scale);
    // merge consecutive rows of the same half (linesForHalves emits one half-entry per row)
    const merged = new Map();
    for (const h of halfObjs) {
      const key = h.side + ':' + h.box.left + ':' + h.box.top;
      if (!merged.has(key)) merged.set(key, { side: h.side, box: h.box, lines: [] });
      merged.get(key).lines.push(...h.lines);
    }
    const order = { L: 0, R: 1 };
    const halvesOut = [...merged.values()].sort((a, b) => order[a.side] - order[b.side]);
    fs.writeFileSync(outFile, JSON.stringify({ page: p, geom: { ...g, file: g.file }, halves: halvesOut }));
    count++;
    process.stderr.write(`[textlayer] page ${p}\n`);
  }
  return count;
}

module.exports = { extract, parsePages };

if (require.main === module) {
  // usage: node src/textlayer.js <pdf> <geom.json> <cacheDir> [configPath]
  const geom = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  extract(process.argv[2], geom, process.argv[4], require('./config').loadConfig(process.argv[5]))
    .then((n) => console.log('textlayer done', n, 'pages'));
}
