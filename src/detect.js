// Stage 1a: detect the PDF's characteristics before doing any heavy work.
//  - does it have a text layer? (then OCR can be skipped entirely)
//  - are the pages two-up spreads? (aspect ratio + content width heuristics)
'use strict';
const { execFileSync } = require('child_process');

function pdfInfo(pdf) {
  const out = execFileSync('pdfinfo', ['-f', '1', '-l', '100000', pdf], { maxBuffer: 64 * 1024 * 1024 }).toString();
  const info = { pages: 0, sizes: [] };
  for (const line of out.split('\n')) {
    const m = line.match(/^Pages:\s+(\d+)/);
    if (m) info.pages = +m[1];
    // "Page    1 size: 612 x 792 pts" (with -f/-l) or "Page size: 612 x 792 pts" (single)
    const ps = line.match(/^Page\s+(?:(\d+)\s+)?size:\s+([\d.]+) x ([\d.]+)/);
    if (ps) info.sizes.push({ page: ps[1] ? +ps[1] : info.sizes.length + 1, w: +ps[2], h: +ps[3] });
  }
  if (!info.sizes.length && info.pages) {
    info.sizes = Array.from({ length: info.pages }, (_, i) => ({ page: i + 1, w: 612, h: 792 }));
  }
  return info;
}

function hasTextLayer(pdf, cfg) {
  const sample = Math.min(cfg.detect.textLayerSamplePages, 1e9);
  const args = [pdf];
  if (sample < pdfInfo(pdf).pages) args.push('-l', String(sample));
  args.push('-');
  let text = '';
  try {
    text = execFileSync('pdftotext', args, { maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch {
    return false;
  }
  const alnum = (text.match(/[A-Za-z0-9]/g) || []).length;
  return alnum >= cfg.detect.textLayerMinChars;
}

// Decide per-page whether it is a two-up spread from the PDF page dimensions.
// A page whose width/height ratio exceeds detect.spreadAspect is treated as a
// spread; pdfinfo sizes are in points and are authoritative here.
function detectSpreads(pdf, cfg) {
  const info = pdfInfo(pdf);
  const sizes = info.sizes.length
    ? info.sizes
    : Array.from({ length: info.pages }, (_, i) => ({ page: i + 1, w: 612, h: 792 }));
  return {
    pageCount: info.pages,
    textLayer: hasTextLayer(pdf, cfg),
    spreads: sizes.map((s) => s.w / s.h > cfg.detect.spreadAspect),
    sizes,
  };
}

module.exports = { pdfInfo, hasTextLayer, detectSpreads };

if (require.main === module) {
  const cfg = require('./config').loadConfig(process.argv[3]);
  console.log(JSON.stringify(detectSpreads(process.argv[2], cfg), null, 1));
}
