// End-to-end pipeline test: generates a synthetic 3-page PDF (see makeFixture.js),
// runs the full CLI pipeline on it (text-layer path, no OCR), and validates
// the resulting EPUB. No book content lives in this repo.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { writeFixture } = require('./makeFixture');

const ROOT = path.join(__dirname, '..');

test('pipeline: fixture PDF -> EPUB -> validation', { timeout: 120000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf2epub-test-'));
  const pdf = writeFixture(tmp);
  const out = path.join(tmp, 'out');

  const stdout = execFileSync('node', [
    path.join(ROOT, 'bin', 'pdf2epub.js'),
    'convert', pdf,
    '-o', out,
    '--title', 'The Test Book',
    '--author', 'Fixture Author',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  // ---- rasterize + geometry
  const pages = fs.readdirSync(path.join(out, 'pages')).filter((f) => f.endsWith('.jpg'));
  assert.strictEqual(pages.length, 3, 'three rasterized pages');
  const geom = JSON.parse(fs.readFileSync(path.join(out, 'cache', 'geom.json'), 'utf8'));
  assert.strictEqual(geom[0].mode, 'spread', 'page 1 detected as two-up spread');
  assert.strictEqual(geom[1].mode, 'single', 'page 2 detected as single page');
  assert.strictEqual(geom[2].mode, 'single', 'page 3 detected as single page');

  // ---- text layer used instead of OCR
  assert.ok(fs.existsSync(path.join(out, 'cache', 'ocr', 'page-001.json')), 'text-layer extraction wrote page json');
  const p1 = JSON.parse(fs.readFileSync(path.join(out, 'cache', 'ocr', 'page-001.json'), 'utf8'));
  assert.strictEqual(p1.halves.length, 2, 'spread page has two halves');
  assert.ok(p1.halves[0].lines.some((l) => l.text.includes('THE TEST BOOK')), 'left half text present');
  assert.ok(p1.halves[1].lines.some((l) => l.text.includes('CHAPTER ONE')), 'right half text present');

  // ---- figures: exactly the filled rectangle
  const figIndex = JSON.parse(fs.readFileSync(path.join(out, 'cache', 'figures.json'), 'utf8'));
  const figCount = figIndex.reduce((s, a) => s + a.figures.length, 0);
  assert.strictEqual(figCount, 1, `exactly one figure detected (got ${figCount})`);
  assert.ok(fs.existsSync(path.join(out, 'figures', 'p002-fig1.png')), 'figure crop written');

  // ---- assembled markdown
  const raw = fs.readFileSync(path.join(out, 'raw_extracted.md'), 'utf8');
  assert.match(raw, /<!-- scan p\. 1 · book pp\. 1–2 -->/, 'spread page marker with book pages');
  assert.match(raw, /<!-- scan p\. 2 · book pp\. 3–3 -->/, 'single page marker');
  assert.match(raw, /book pp\. 3–3/, 'folio calibration found offset 1');
  assert.doesNotMatch(raw, /\n3\n/, 'page number not rendered as body text');

  // ---- chapters
  const report = JSON.parse(fs.readFileSync(path.join(out, 'chapters.json'), 'utf8'));
  const titles = report.map((c) => c.title);
  assert.ok(titles.includes('CHAPTER ONE'), `chapter one present in ${JSON.stringify(titles)}`);
  assert.ok(titles.includes('CHAPTER TWO'), 'chapter two present');
  const chTwoFile = report.find((c) => c.title === 'CHAPTER TWO').fname;
  const chTwo = fs.readFileSync(path.join(out, 'chapters', chTwoFile), 'utf8');
  assert.match(chTwo, /# CHAPTER TWO/, 'chapter heading');
  assert.match(chTwo, /\bexample\b/, 'hyphenated "exam-"/"ple" rejoined');
  assert.doesNotMatch(chTwo, /^3$/m, 'folio stripped from chapter body');

  // ---- epub skeleton
  const oebps = path.join(out, 'epub', 'OEBPS');
  const xhtml = fs.readdirSync(oebps).filter((f) => f.endsWith('.xhtml'));
  assert.ok(xhtml.length >= report.length + 1, 'chapter xhtml files + nav generated');
  assert.ok(fs.existsSync(path.join(oebps, 'images', 'p002-fig1.png')), 'referenced image copied into OEBPS');
  const css = fs.readFileSync(path.join(oebps, 'styles.css'), 'utf8');
  for (const rule of ['page-break-before: always', 'text-indent: 1.2em', 'max-width: 100%', 'height: auto']) {
    assert.ok(css.includes(rule), `css has ${rule}`);
  }

  // ---- packaged epub + validation
  const epubFile = path.join(out, 'the_test_book.epub');
  assert.ok(fs.existsSync(epubFile), 'epub file written');
  assert.match(stdout, /PACKAGE VALID|mimetype first entry/, 'CLI validation ran');

  // re-validate explicitly
  const v = require('../src/validate').validate(epubFile, { expectedChapters: report.length });
  assert.deepStrictEqual(v.problems, [], `validation problems: ${JSON.stringify(v.problems)}`);
  assert.strictEqual(v.counts.chapters, report.length);
  assert.ok(v.counts.images >= 1, 'image in manifest');
});
