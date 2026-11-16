// Stage 6: chapterize + clean. Splits the assembled book into chapters and
// cleans each one: running heads, title-page furniture, page numbers, TOC
// fragments, de-hyphenation and paragraph merging.
//
// Chapter boundaries come from either:
//   - a profile `chapters` list: [{title, scan, titleSide: "R"}] — exact
//     book-specific control (titleSide "R" = chapter starts on the right half
//     of the opening spread), or
//   - heuristics: chapterPattern headings (CHAPTER/PART/STEP + number/word).
'use strict';
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------- linearize blocks
// assembled.json page blocks -> flat markdown-ish block list
function linearize(pages) {
  const out = [];
  for (const pg of pages) {
    if (pg.duplicate) continue;
    for (const b of pg.blocks) {
      if (b.type === 'col') { for (const c of b.blocks) out.push({ ...c, page: pg.page, side: b.side }); }
      else if (b.type === 'layout' || b.type === 'toc2') out.push({ type: 'fence', page: pg.page, side: b.side });
      else if (b.type === 'toc') out.push({ type: 'p', text: b.text, page: pg.page, side: b.side });
      else if (b.type === 'fig') out.push({ type: 'fig', file: b.fig.file, page: pg.page, side: b.side, y: b.y });
      else out.push({ type: b.type, text: b.text, level: b.level, page: pg.page, side: b.side, y: b.y });
    }
  }
  return out;
}

// ------------------------------------------------------- junk rules (profile)
function buildMatchers(cfg) {
  const cz = cfg.chapterize;
  const junkText = (cz.junkText || []).map((s) => new RegExp(s, 'i'));
  const chapterPatterns = (cz.chapterPatterns || []).map((s) => new RegExp(s, 'i'));
  return { junkText, chapterPatterns };
}

const isPageMarker = () => false; // markers never appear in assembled blocks
const isImprint = (t, junkText) => junkText.some((re) => re.test(t));

function isTocLike(t) {
  if (/\.{5,}/.test(t)) return true;
  if (/\booo\b|\bOOO\b/.test(t)) return true;
  if (/^Page\s+[A-Z]/.test(t)) return true;
  if (/\bPage\s+Page\b/.test(t)) return true;
  if (/^\s*PART\s+(ONE|TWO|THREE|FOUR|FIVE|SIX)\s*:?\s+[A-Z]/.test(t) && /\s{3,}/.test(t)) return true;
  return false;
}

function isStrayNumber(t) {
  return /^[^A-Za-z0-9]{0,3}\d{1,3}[^A-Za-z0-9]{0,3}$/.test(t.trim());
}

function isTitleHeading(t, titles) {
  const h = t.trim();
  for (const title of titles) if (h.toLowerCase() === title.toLowerCase()) return true;
  if (/^CONTENTS$/i.test(h)) return true;
  if (/^PART\s+(ONE|TWO|THREE|FOUR|FIVE|SIX)$/i.test(h)) return true;
  return false;
}

function isContentParagraph(t, junkText) {
  if (isTocLike(t) || isImprint(t, junkText)) return false;
  if (isStrayNumber(t)) return false;
  return t.length >= 120;
}

function isRunningHead(t, chapterTitle, cfg) {
  const cz = cfg.chapterize;
  if (t.length > cz.runningHeadMaxLen) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < cz.runningHeadMinLetters) return false;
  const caps = (letters.match(/[A-Z]/g) || []).length / letters.length;
  if (caps < cz.runningHeadMinCaps) return false;
  const target = chapterTitle.replace(/[^A-Za-z]/g, '').toUpperCase();
  const s = letters.toUpperCase();
  return s.startsWith(target.slice(0, Math.max(8, target.length - 2))) || s.includes(target);
}

// ------------------------------------------------------- title-page stripping
function stripOpeningJunk(blocks, chapterTitle, cfg) {
  const hIdx = blocks.findIndex((b) => b.type === 'h');
  const end = hIdx >= 0 ? hIdx : Math.min(blocks.length, 12);
  return blocks.filter((b, i) => {
    if (i >= end) return true;
    if (b.type !== 'p') return true;
    const t = b.text.trim();
    if (isRunningHead(t, chapterTitle, cfg)) return false;
    if (t.length < cfg.chapterize.shortParaKeep && !/[.!?…]["'”’)\]]*$/.test(t)) return false;
    return true;
  });
}

function stripTitlePage(blocks, cfg, junkText, titles) {
  const fenceIdx = blocks.findIndex((b) => b.type === 'fence');
  if (fenceIdx >= 0 && fenceIdx <= cfg.chapterize.stripOpeningFenceLimit) {
    const head = blocks.slice(0, fenceIdx).filter((b) => {
      if (b.type !== 'p') return false;
      const t = b.text;
      if (isContentParagraph(t, junkText)) return true;
      return t.length <= cfg.chapterize.epigraphKeep && /[.!?…]["'”’)\]]*$/.test(t) &&
        !isImprint(t, junkText) && !isTocLike(t) && !/^CORINDA\.?$/i.test(t) && !isStrayNumber(t);
    });
    return [...head, ...blocks.slice(fenceIdx + 1)];
  }
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === 'fig') { i++; continue; }
    if (b.type === 'h') {
      if (isTitleHeading(b.text, titles)) { i++; continue; }
      break;
    }
    if (b.type === 'p') {
      if (isContentParagraph(b.text, junkText)) break;
      i++; continue;
    }
    break;
  }
  return blocks.slice(i);
}

// ------------------------------------------------------- paragraph merging
const STOP_TAIL = /\b(of|the|a|an|and|or|to|in|on|at|with|from|for|by|as|is|was|were|are|be|been|that|which|who|whose|if|it|its|his|her|their|this|these|those|not|but|when|while|because|than|then|so)$/i;
const TERMINAL = /[.!?…:;]["'”’)\]]*$/;

function startsLower(t) {
  return /^["'“‘(\[]?[a-z0-9]/.test(t.trim());
}

function needsJoin(a, b, cfg) {
  const t = a.trim();
  if (/[A-Za-z]-$/.test(t)) return true;
  if (/[—–]$/.test(t)) return true;
  if (TERMINAL.test(t)) return false;
  if (t.length < cfg.chapterize.join.shortHeadingLen && (/^\(?\d+\)?\s+[A-Z]/.test(t) || /^\([a-z]\)\s/.test(t))) return false;
  const L = t.replace(/[^A-Za-z]/g, '');
  if (t.length < cfg.chapterize.join.capsLen && L.length > 20) {
    const caps = (L.match(/[A-Z]/g) || []).length / L.length;
    if (caps > cfg.chapterize.join.capsRatio) return false;
  }
  if (startsLower(b)) return true;
  if (STOP_TAIL.test(t)) return true;
  return false;
}

function joinText(a, b) {
  const t = a.replace(/\s+$/, '');
  const n = b.replace(/^\s+/, '');
  if (/[A-Za-z]-$/.test(t)) return t.slice(0, -1) + n;
  if (/[—–]$/.test(t)) return t + n;
  return t + ' ' + n;
}

function mergeParagraphs(blocks, cfg) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < blocks.length; i++) {
      const a = blocks[i];
      if (a && a.type === 'h' && /[A-Za-z]-$/.test(a.text.trim())) {
        const nb = blocks[i + 1];
        if (nb && nb.type === 'p' && startsLower(nb.text)) {
          blocks.splice(i, 1, { type: 'p', text: joinText(a.text, nb.text) });
          blocks.splice(i + 1, 1);
          changed = true;
          break;
        }
      }
      if (!a || a.type !== 'p') continue;
      const b = blocks[i + 1];
      if (b && b.type === 'p' && needsJoin(a.text, b.text, cfg)) {
        a.text = joinText(a.text, b.text);
        blocks.splice(i + 1, 1);
        changed = true;
        break;
      }
      if (/[A-Za-z]-$/.test(a.text.trim())) {
        let j = i + 1;
        const figs = [];
        while (blocks[j] && blocks[j].type === 'fig') { figs.push(blocks[j]); j++; }
        if (figs.length && blocks[j] && blocks[j].type === 'p' && startsLower(blocks[j].text)) {
          a.text = joinText(a.text, blocks[j].text);
          blocks.splice(i + 1, j - i);
          const merged = blocks.splice(i, 1)[0];
          blocks.splice(i, 0, merged, ...figs);
          changed = true;
          break;
        }
      }
    }
  }
  return blocks;
}

// ------------------------------------------------------- chapter boundaries
// Profile mode: exact per-page/side attribution.
function splitByProfile(pages, chapters) {
  const ranges = chapters.map((c, i) => ({
    ...c,
    index: i,
    endScan: chapters[i + 1] ? chapters[i + 1].scan : Infinity,
  }));
  const out = ranges.map(() => []);
  for (const pg of pages) {
    if (pg.duplicate) continue;
    for (const b of pg.blocks) {
      let target = -1;
      for (let i = ranges.length - 1; i >= 0; i--) {
        const r = ranges[i];
        if (pg.page > r.scan || (pg.page === r.scan && (r.titleSide !== 'R' || b.side === 'R'))) { target = i; break; }
      }
      if (target < 0) continue; // front matter before the first chapter
      const b2 = { ...b, page: pg.page };
      if (b.type === 'col') { for (const c of b.blocks) out[target].push({ ...c, page: pg.page }); }
      else if (b.type === 'layout' || b.type === 'toc2') out[target].push({ type: 'fence', page: pg.page });
      else if (b.type === 'toc') out[target].push({ type: 'p', text: b.text, page: pg.page });
      else if (b.type === 'fig') out[target].push({ type: 'fig', file: b.fig.file, page: pg.page });
      else out[target].push({ type: b.type, text: b.text, level: b.level, page: pg.page });
    }
  }
  return out;
}

// Heuristic mode: split at headings matching chapter patterns.
function splitByHeuristic(pages, cfg) {
  const { chapterPatterns } = buildMatchers(cfg);
  const blocks = linearize(pages);
  const isChapterHead = (b) => b.type === 'h' && (b.level <= 2) &&
    (chapterPatterns.length ? chapterPatterns.some((re) => re.test(b.text)) : true);
  const chapters = [{ title: null, blocks: [] }];
  for (const b of blocks) {
    if (isChapterHead(b)) chapters.push({ title: b.text, blocks: [] });
    else chapters[chapters.length - 1].blocks.push(b);
  }
  return chapters;
}

// ------------------------------------------------------- rendering
function renderChapter(blocks, title) {
  const out = [`# ${title}`, ''];
  for (const b of blocks) {
    if (b.type === 'h') {
      const lvl = Math.min(6, Math.max(2, b.level));
      out.push(`${'#'.repeat(lvl)} ${b.text}`, '');
    } else if (b.type === 'fig') {
      out.push(`![Figure](../figures/${b.file})`, '');
    } else if (b.type === 'p' || b.type === 'line') {
      out.push(b.text, '');
    }
    // fences ('fence') are dropped: they are title-page contents tables
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ------------------------------------------------------- main
function run(outDir, cfg, meta = {}) {
  const assembled = JSON.parse(fs.readFileSync(path.join(outDir, 'assembled.json'), 'utf8'));
  const { junkText } = buildMatchers(cfg);
  const chaptersDir = path.join(outDir, 'chapters');
  fs.mkdirSync(chaptersDir, { recursive: true });
  for (const f of fs.readdirSync(chaptersDir)) if (/^chapter-\d+\.md$/.test(f)) fs.unlinkSync(path.join(chaptersDir, f));

  const report = [];
  let groups;

  if (cfg.chapters && cfg.chapters.length) {
    groups = splitByProfile(assembled.pages, cfg.chapters).map((blocks, i) => ({
      title: cfg.chapters[i].title,
      blocks,
    }));
  } else {
    groups = splitByHeuristic(assembled.pages, cfg);
  }
  const titles = groups.map((g) => g.title).filter(Boolean);
  if (groups.length === 1 && !groups[0].title) {
    groups[0].title = meta.title || 'Chapter 1';
  }

  groups.forEach((g, i) => {
    if (!g.title) g.title = `Chapter ${i + 1}`;
    let blocks = g.blocks.filter((b) => !(b.type === 'h' && /^Notes on the extraction$/.test(b.text)));
    blocks = stripTitlePage(blocks, cfg, junkText, titles);
    blocks = stripOpeningJunk(blocks, g.title, cfg);
    blocks = blocks.filter((b) => {
      if (b.type === 'fence') return false;
      if (b.type === 'p') {
        if (isStrayNumber(b.text)) return false;
        if (isImprint(b.text, junkText)) return false;
        if (isTocLike(b.text) && (b.text.length < cfg.chapterize.tocLikeMaxLen || /No part of this Publication/i.test(b.text))) return false;
      }
      if (b.type === 'h' && isTitleHeading(b.text, titles)) return false;
      return true;
    });
    blocks = mergeParagraphs(blocks, cfg);

    let words = 0, paragraphs = 0, figs = 0;
    for (const b of blocks) {
      if (b.type === 'p') { paragraphs++; words += b.text.split(/\s+/).filter(Boolean).length; }
      if (b.type === 'fig') figs++;
    }
    const fname = `chapter-${String(i + 1).padStart(2, '0')}.md`;
    fs.writeFileSync(path.join(chaptersDir, fname), renderChapter(blocks, g.title));
    report.push({ fname, title: g.title, paragraphs, words, figs, blocks: blocks.length });
  });

  fs.writeFileSync(path.join(outDir, 'chapters.json'), JSON.stringify(report, null, 1));
  return report;
}

module.exports = { run, linearize, mergeParagraphs, stripTitlePage };

if (require.main === module) {
  // usage: node src/chapterize.js <outDir> [configPath]
  const cfg = require('./config').loadConfig(process.argv[3]);
  console.log(JSON.stringify(run(process.argv[2], cfg), null, 1));
}
