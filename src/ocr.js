// Stage 3a: OCR each page half with tesseract.js. Resumable: pages already
// present in the OCR cache are skipped. Results match the text-layer JSON shape
// (see src/textlayer.js) so downstream stages are format-agnostic.
'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const { halvesOf } = require('./halves');

async function ocrHalf(worker, file, box, side) {
  const buf = await sharp(file).extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .greyscale().png().toBuffer();
  const { data } = await worker.recognize(buf, {}, { blocks: true, text: true });
  const lines = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        lines.push({
          text: l.text,
          conf: l.confidence,
          bbox: l.bbox,
          words: (l.words || []).map((w) => ({ text: w.text, conf: w.confidence, bbox: w.bbox })),
        });
      }
    }
  }
  return { side, box, lines };
}

async function workerLoop(id, jobs, cfg, cacheDir, pagesDir, onProgress) {
  const w = await createWorker(cfg.ocr.lang, 1, { cachePath: cacheDir });
  await w.setParameters({ preserve_interword_spaces: '1' });
  for (const { pg, geom, geomPath } of jobs) {
    const outFile = path.join(cacheDir, `page-${String(pg).padStart(3, '0')}.json`);
    if (fs.existsSync(outFile)) { onProgress(pg, true); continue; }
    const file = path.join(pagesDir, geom.file);
    const halves = [];
    for (const hf of halvesOf(geom)) halves.push(await ocrHalf(w, file, hf.box, hf.side));
    fs.writeFileSync(outFile, JSON.stringify({ page: pg, geom: { ...geom, file: geomPath }, halves }));
    onProgress(pg, false);
  }
  await w.terminate();
}

async function run(geom, pagesDir, cacheDir, cfg, opts = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const start = opts.start || 1, end = opts.end || geom.length;
  const jobs = [];
  for (let p = start; p <= end; p++) {
    const g = geom[p - 1];
    if (!g) continue;
    jobs.push({ pg: p, geom: g, geomPath: g.file });
  }
  const workers = Math.max(1, opts.workers || cfg.ocr.workers);
  const buckets = Array.from({ length: workers }, () => []);
  jobs.forEach((j, i) => buckets[i % workers].push(j));
  let done = 0;
  const onProgress = (pg, skipped) => {
    done++;
    process.stderr.write(`[ocr] ${done}/${jobs.length} page ${pg}${skipped ? ' (cached)' : ''}\n`);
  };
  await Promise.all(buckets.map((b, i) => workerLoop(i, b, cfg, cacheDir, pagesDir, onProgress)));
  return jobs.length;
}

module.exports = { run, ocrHalf };

if (require.main === module) {
  // usage: node src/ocr.js <geom.json> <pagesDir> <cacheDir> [configPath]
  const geom = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  run(geom, process.argv[3], process.argv[4], require('./config').loadConfig(process.argv[5]))
    .then((n) => console.log('ocr done', n, 'pages'));
}
