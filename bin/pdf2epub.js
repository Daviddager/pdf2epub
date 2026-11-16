#!/usr/bin/env node
// pdf2epub — convert a PDF (scanned or text-layer) into a structured EPUB.
//
//   pdf2epub book.pdf -o out/ --title "My Book" --author "An Author"
//   pdf2epub book.pdf --from ocr --resume
//   pdf2epub validate out/My_Book.epub
'use strict';
const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const { loadConfig } = require('../src/config');

const STAGES = ['rasterize', 'detect', 'geometry', 'extract', 'figures', 'assemble', 'chapterize', 'epub', 'package'];
// 'detect' runs inside rasterize/extract decisions; keep it listed for --from clarity.

function pkg(outDir) { return JSON.parse(fs.readFileSync(path.join(outDir, 'state.json'), 'utf8')); }
function saveState(outDir, state) {
  state.stages = state.stages || {};
  state.stages[stageName] = { at: new Date().toISOString() };
  fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(state, null, 1));
}
let stageName = '';

async function main() {
  program
    .name('pdf2epub')
    .description('Convert a PDF into an EPUB (OCR or text-layer path).')
    .version(require('../package.json').version);

  program
    .command('convert', { isDefault: true })
    .argument('<pdf>', 'input PDF file')
    .option('-o, --out <dir>', 'output directory', 'out')
    .option('-t, --title <title>', 'book title')
    .option('-a, --author <author>', 'book author')
    .option('-l, --language <lang>', 'language code', '')
    .option('--publisher <name>', 'publisher name', '')
    .option('-p, --profile <file>', 'book profile JSON (rules only, no content)')
    .option('--single', 'force single-page mode (disable spread detection)')
    .option('--force-ocr', 'run OCR even if the PDF has a text layer')
    .option('--dpi <n>', 'rasterization DPI', '150')
    .option('--workers <n>', 'OCR worker count')
    .option('--from <stage>', `resume from a stage (${STAGES.join(' | ')})`)
    .option('--resume', 'skip stages already completed (recorded in out/state.json)')
    .action(async (pdf, opts) => {
      if (!fs.existsSync(pdf)) { console.error(`no such file: ${pdf}`); process.exit(1); }
      const cfg = loadConfig(opts.profile);
      if (opts.dpi) cfg.raster.dpi = +opts.dpi;
      if (opts.workers) cfg.ocr.workers = +opts.workers;
      const outDir = path.resolve(opts.out);
      fs.mkdirSync(outDir, { recursive: true });
      const meta = {
        title: opts.title || path.basename(pdf).replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '),
        author: opts.author || 'Unknown',
        source: path.resolve(pdf),
        language: opts.language,
        publisher: opts.publisher,
      };
      let state = { pdf: path.resolve(pdf), meta, stages: {} };
      if (opts.resume && fs.existsSync(path.join(outDir, 'state.json'))) state = pkg(outDir);
      state.meta = { ...state.meta, ...meta };
      const from = opts.from ? STAGES.indexOf(opts.from) : 0;
      if (opts.from && from < 0) { console.error(`unknown stage ${opts.from}; choose from: ${STAGES.join(', ')}`); process.exit(1); }
      const done = (s) => opts.resume && state.stages[s] && !opts.from;

      const det = require('../src/detect').detectSpreads(pdf, cfg);
      const forceSingle = !!opts.single;
      const useTextLayer = det.textLayer && !opts.forceOcr;
      console.error(`[pdf2epub] ${det.pageCount} pages, text layer: ${useTextLayer ? 'yes' : 'no'}${forceSingle ? ', single-page mode forced' : ''}`);

      const run = async (name, fn) => {
        if (STAGES.indexOf(name) < from) return;
        if (done(name)) { console.error(`[pdf2epub] ${name}: already done, skipping (--resume)`); return; }
        stageName = name;
        const t0 = Date.now();
        await fn();
        saveState(outDir, state);
        console.error(`[pdf2epub] ${name} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      };

      const pagesDir = path.join(outDir, 'pages');
      const cacheDir = path.join(outDir, 'cache');
      const ocrDir = path.join(cacheDir, 'ocr');
      const figuresDir = path.join(outDir, 'figures');

      let geom = null;
      await run('rasterize', () => {
        require('../src/rasterize').rasterize(pdf, pagesDir, cfg);
      });
      fs.mkdirSync(cacheDir, { recursive: true });
      await run('detect', () => { /* text-layer/spread detection already computed */ });

      await run('geometry', async () => {
        geom = await require('../src/geometry').analyze(pagesDir, cfg, { forceSingle });
        fs.writeFileSync(path.join(cacheDir, 'geom.json'), JSON.stringify(geom));
      });
      if (!geom) geom = JSON.parse(fs.readFileSync(path.join(cacheDir, 'geom.json'), 'utf8'));
      if (geom.length !== det.pageCount) {
        console.error(`[pdf2epub] warning: ${geom.length} rasterized pages vs ${det.pageCount} PDF pages`);
      }

      await run('extract', () => {
        if (useTextLayer) {
          return require('../src/textlayer').extract(pdf, geom, ocrDir, cfg, { sizes: det.sizes });
        }
        return require('../src/ocr').run(geom, pagesDir, ocrDir, cfg, {});
      });

      await run('figures', async () => {
        await require('../src/figures').run(ocrDir, pagesDir, figuresDir, path.join(cacheDir, 'figures.json'), cfg, {});
      });

      let assembled = null;
      await run('assemble', async () => {
        assembled = await require('../src/assemble').run(ocrDir, pagesDir, figuresDir, outDir, cfg, { ...meta, textLayer: useTextLayer });
      });

      await run('chapterize', () => {
        require('../src/chapterize').run(outDir, cfg, meta);
      });

      await run('epub', () => {
        require('../src/epub').run(outDir, cfg, meta);
      });

      let packed = null;
      await run('package', async () => {
        packed = await require('../src/package').run(outDir, meta);
      });

      const v = require('../src/validate').validate(packed.file, { expectedChapters: JSON.parse(fs.readFileSync(path.join(outDir, 'chapters.json'), 'utf8')).length });
      console.log(v.info.join('\n'));
      if (!v.ok) {
        console.error('PROBLEMS:\n' + v.problems.join('\n'));
        process.exit(1);
      }
      console.log(`\nOK: ${packed.file} (${(packed.size / 1024 / 1024).toFixed(1)} MiB, ${v.counts.chapters} chapters)`);
    });

  program
    .command('validate')
    .description('validate a compiled .epub file')
    .argument('<epub>', 'the .epub file')
    .option('--expected-chapters <n>', 'expected chapter count')
    .action((epub, opts) => {
      const r = require('../src/validate').validate(epub, { expectedChapters: opts.expectedChapters ? +opts.expectedChapters : undefined });
      console.log(r.info.join('\n'));
      if (!r.ok) {
        console.error('\nPROBLEMS:\n' + r.problems.join('\n'));
        process.exit(1);
      }
      console.log(`\nPACKAGE VALID: ${epub} (${r.counts.entries} entries, ${r.counts.chapters} chapters)`);
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
