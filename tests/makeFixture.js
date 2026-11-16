// Generates a tiny synthetic PDF for the test suite — no external dependencies,
// no book content. Uncompressed PDF 1.4 with a real text layer (Helvetica base
// font), three pages:
//   page 1: a two-up spread (1224x792 pt) — front matter on the left,
//           "CHAPTER ONE" + body on the right, folios "1"/"2"
//   page 2: single page — "CHAPTER TWO" + body with a hyphenated word wrap
//           ("exam-"/"ple"), a filled-rectangle "figure", folio "3"
//   page 3: single page — more chapter-two body text, folio "4"
'use strict';
const fs = require('fs');
const path = require('path');

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function textOps(lines, size = 11) {
  return lines.map((l) => `BT /F1 ${l.size || size} Tf ${l.x} ${l.y} Td (${esc(l.t)}) Tj ET`).join('\n');
}

function page1() {
  const left = [
    { t: 'THE TEST BOOK', x: 80, y: 700, size: 14 },
    { t: 'by the fixture generator', x: 80, y: 676 },
    { t: 'This front matter page exists so that the left half of the opening spread is not empty', x: 80, y: 644 },
    { t: 'and the content box of the rasterized image spans nearly the full width of the page.', x: 80, y: 628 },
  ];
  const right = [
    { t: 'CHAPTER ONE', x: 674, y: 700, size: 14 },
    { t: 'This is the first chapter of the synthetic test book. It exists to exercise the text layer', x: 674, y: 660 },
    { t: 'pipeline without any optical character recognition whatsoever. The paragraphs below reflow', x: 674, y: 644 },
    { t: 'like real body text while the page numbers at the foot of every page must be stripped', x: 674, y: 628 },
    { t: 'away by the cleaner stage before the chapter files are finally written out to disk.', x: 674, y: 612 },
  ];
  return {
    w: 1224, h: 792,
    content: [
      textOps(left), textOps(right),
      textOps([{ t: '1', x: 300, y: 60 }]),
      textOps([{ t: '2', x: 910, y: 60 }]),
    ].join('\n'),
  };
}

function page2() {
  const body = [
    { t: 'CHAPTER TWO', x: 90, y: 700, size: 14 },
    { t: 'The second chapter contains a hyphenated line break. The word', x: 90, y: 660 },
    { t: 'exam-', x: 90, y: 644 },
    { t: 'ple begins here and must be rejoined into a single token by the', x: 90, y: 628 },
    { t: 'assembler before any cleaning happens.', x: 90, y: 612 },
  ];
  const rect = '0 0 0 rg 150 430 90 150 re f';
  const after = [
    { t: 'After the illustration the text continues with a short paragraph', x: 90, y: 380 },
    { t: 'that proves the crop is placed back into the reading flow.', x: 90, y: 364 },
  ];
  return {
    w: 612, h: 792,
    content: [textOps(body), rect, textOps(after), textOps([{ t: '3', x: 300, y: 60 }])].join('\n'),
  };
}

function page3() {
  const body = [
    { t: 'The final page carries more ordinary text so that every chapter', x: 90, y: 700 },
    { t: 'has more than one page of content. Nothing clever happens here.', x: 90, y: 684 },
  ];
  return {
    w: 612, h: 792,
    content: [textOps(body), textOps([{ t: '4', x: 300, y: 60 }])].join('\n'),
  };
}

function makePdf() {
  const pages = [page1(), page2(), page3()];
  const objs = [];
  // 1: catalog, 2: pages, 3..: page objects, then content streams
  const pageObjIds = pages.map((_, i) => 3 + i * 2);
  const contentIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  pages.forEach((p, i) => {
    objs[pageObjIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 20 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
    const stream = p.content;
    objs[contentIds[i]] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objs[20] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i <= 20; i++) {
    if (!objs[i]) continue;
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 21\n0000000000 65535 f \n`;
  for (let i = 1; i <= 20; i++) {
    out += objs[i] ? String(offsets[i]).padStart(10, '0') + ' 00000 n \n' : '0000000000 65535 f \n';
  }
  out += `trailer\n<< /Size 21 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'fixture.pdf');
  fs.writeFileSync(file, makePdf(), 'latin1');
  return file;
}

module.exports = { writeFixture, makePdf };

if (require.main === module) {
  console.log(writeFixture(process.argv[2] || '.'));
}
