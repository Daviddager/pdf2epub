// Stage 5: assemble OCR/text-layer halves into page blocks and reflowed text.
// Port of the proven assembler: half trimming, folio calibration, column
// detection, paragraph/heading blocks, figure placement, markdown rendering.
// Book-specific rules (title pages, duplicate scans, glyph fixes) come from the
// profile, not from this file.
'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const alnum = (s) => (s.match(/[A-Za-z0-9]/g) || []).length;
const alnumRatio = (s) => { const t = s.replace(/\s/g, ''); return t ? alnum(t) / t.length : 0; };
const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[(b.length / 2) | 0] : 0; };
const pct = (a, q) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.floor((b.length - 1) * q)))]; };

// ---------------------------------------------------------------- noise
function makeIsNoise(C) {
  return function isNoise(l) {
    const t = l.text.trim();
    if (!t) return true;
    if (alnum(t) === 0) return true;
    if (alnumRatio(t) < C.noise.minAlnumRatio && alnum(t) <= C.noise.maxAlnumForRatio) return true;
    if (l.bbox.y0 < C.conf.topStripY && l.conf < C.conf.topStripConf && t.length < C.conf.topStripMaxLen) return true;
    if (l.conf < C.conf.lowConf && alnumRatio(t) < C.conf.lowConfAlnumRatio) return true;
    const ws = (l.words || []).map((w) => w.text).filter((w) => alnum(w) > 0);
    if (ws.length === 1 && ws[0].length <= 1 && l.conf < C.noise.shortWordMaxConf) return true;
    if (ws.length && l.conf < 55 && ws.reduce((s, w) => s + w.length, 0) / ws.length < 3) return true;
    if (l.conf < C.conf.veryLowConf) return true;
    return false;
  };
}

// Strip edge speckle / gutter bleed from a half's lines.
function trimHalfLines(lines, C) {
  const starts = [], ends = [];
  const lastGood = (w) => w && w.conf >= C.conf.halfTrimConf && alnum(w.text) >= 2 && alnumRatio(w.text) >= 0.6;
  const firstGood = (w) => w && w.conf >= C.conf.halfTrimConf && (alnum(w.text) >= 2 || /^[aAI]$/.test(w.text));
  for (const l of lines) {
    if (l.conf < C.conf.halfTrimLineConf) continue;
    const ws = (l.words || []).filter((w) => alnum(w.text) > 0);
    if (!ws.length) continue;
    if (firstGood(ws[0])) starts.push(ws[0].bbox.x0);
    if (lastGood(ws[ws.length - 1])) ends.push(ws[ws.length - 1].bbox.x1);
  }
  const junkEdge = (w) => {
    if (/^[.,;:!?%&()"'’”—–-]$/.test(w.text)) return false;
    if (w.conf < C.conf.edgeWordConf && (alnum(w.text) === 0 || w.text.replace(/[^A-Za-z0-9]/g, '').length <= 1)) return true;
    if (w.conf < C.conf.junkWordConf && /^\d$/.test(w.text)) return true;
    return false;
  };
  const finalize = (ws, l) => ({
    text: ws.map((w) => w.text).join(' '),
    conf: ws.reduce((s, w) => s + w.conf, 0) / ws.length,
    bbox: { x0: Math.min(...ws.map((w) => w.bbox.x0)), x1: Math.max(...ws.map((w) => w.bbox.x1)), y0: l.bbox.y0, y1: l.bbox.y1 },
    words: ws,
  });
  if (starts.length < 4 || ends.length < 4) {
    const out = [];
    for (const l of lines) {
      const ws = (l.words || []).slice();
      while (ws.length && junkEdge(ws[0])) ws.shift();
      while (ws.length && junkEdge(ws[ws.length - 1])) ws.pop();
      if (!ws.length) continue;
      out.push(finalize(ws, l));
    }
    return out;
  }
  const colL = pct(starts, 0.08), colR = pct(ends, 0.9);
  const out = [];
  for (const l of lines) {
    let ws = (l.words || []).slice();
    ws = ws.filter((w) => {
      const b = w.bbox;
      if (b.x1 < colL - 12 || b.x0 > colR + 12) {
        if (w.conf > C.conf.columnKeepConf && alnum(w.text) >= C.conf.columnKeepAlnum && alnumRatio(w.text) > C.conf.columnKeepRatio) return true;
        return false;
      }
      return true;
    });
    while (ws.length && junkEdge(ws[0])) ws.shift();
    while (ws.length && junkEdge(ws[ws.length - 1])) ws.pop();
    if (!ws.length) continue;
    out.push(finalize(ws, l));
  }
  return out;
}

function cleanText(s) {
  let t = s.replace(/\s+/g, ' ').trim();
  t = t.replace(/[|]/g, ' ').replace(/(\s*\.\s*){5,}/g, ' .......... ');
  t = t.replace(/\s+/g, ' ').trim();
  const toks = t.split(' ');
  const junk = /^[;|~§{}()\[\]“”'",.*_!?]+$/;
  while (toks.length && junk.test(toks[0]) && toks[0].length <= 2) toks.shift();
  while (toks.length && junk.test(toks[toks.length - 1]) && toks[toks.length - 1].length <= 2) toks.pop();
  return toks.join(' ').trim();
}

const isAllCaps = (s) => {
  const L = s.replace(/[^A-Za-z]/g, '');
  if (L.length < 3) return false;
  return (L.match(/[A-Z]/g) || []).length / L.length > 0.85;
};

function detachPageNumber(lines, boxH, C) {
  const nums = [], keep = [];
  for (const l of lines) {
    const t = cleanText(l.text);
    if (/^\d{1,3}$/.test(t) && l.bbox.y0 > boxH * 0.84 && l.conf > C.conf.folioDetachedConf) { nums.push(t); continue; }
    keep.push(l);
  }
  return { nums, keep };
}

function detectColumns(lines, width, C) {
  if (lines.length < C.columns.minLines) return null;
  const bins = new Map();
  let n = 0;
  for (const l of lines) {
    const ws = (l.words || []).filter((w) => alnum(w.text) > 0);
    if (ws.length < 3) continue;
    n++;
    const diffs = [];
    for (let i = 1; i < ws.length; i++) diffs.push(ws[i].bbox.x0 - ws[i - 1].bbox.x1);
    const med = median(diffs) || 6;
    for (let i = 1; i < ws.length; i++) {
      const g = ws[i].bbox.x0 - ws[i - 1].bbox.x1;
      if (g < Math.max(C.columns.minGapAbs, med * C.columns.minGapFactor)) continue;
      const c = (ws[i - 1].bbox.x1 + ws[i].bbox.x0) / 2;
      const k = Math.round(c / C.columns.binWidth) * C.columns.binWidth;
      bins.set(k, (bins.get(k) || 0) + 1);
    }
  }
  if (n < C.columns.minLines) return null;
  let best = null;
  for (const [k, v] of bins) {
    if (k < width * C.columns.bandLo || k > width * C.columns.bandHi) continue;
    if (v >= Math.max(C.columns.minVotes, n * C.columns.minVotesFactor) && (!best || v > best.v)) best = { x: k, v };
  }
  return best ? best.x : null;
}

// Conservative whole-word glyph fix-ups, supplied by the profile.
function makeFixGlyphs(replacements) {
  const rules = (replacements || []).map((r) =>
    typeof r === 'string' ? null : { re: new RegExp(r.from, r.flags || 'g'), to: r.to });
  return (s) => {
    let t = s;
    for (const r of rules) if (r) t = t.replace(r.re, r.to);
    return t;
  };
}

function makeJoinLines(fixGlyphs) {
  return function joinLines(lines) {
    let out = '';
    for (const t of lines) {
      if (!out) { out = t; continue; }
      if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
      else if (out.endsWith('—')) out += t;
      else out += ' ' + t;
    }
    return fixGlyphs(out.replace(/\s+/g, ' ').trim());
  };
}

// ---------------------------------------------------------------- figures
function makeFilterFigure(C) {
  const F = C.figureFilter;
  return function filterFigure(fig, half, pageInfo) {
    const w = fig.rel.x1 - fig.rel.x0, h = fig.rel.y1 - fig.rel.y0;
    const area = w * h;
    let wc = 0, digits = 0;
    for (const l of half.lines) for (const wd of (l.words || [])) {
      const cx = (wd.bbox.x0 + wd.bbox.x1) / 2, cy = (wd.bbox.y0 + wd.bbox.y1) / 2;
      if (cx >= fig.rel.x0 && cx <= fig.rel.x1 && cy >= fig.rel.y0 && cy <= fig.rel.y1) {
        if (wd.conf >= 60 && alnumRatio(wd.text) >= 0.6) { wc++; if (/\d/.test(wd.text)) digits++; }
      }
    }
    if (w < F.minWFinal || h < F.minHFinal || area < F.minAreaFinal) return { keep: false, reason: 'small' };
    if (pageInfo.indexLike) return { keep: false, reason: 'index-page' };
    if (wc >= F.tableMinWords && area < F.tableMaxArea && digits / Math.max(1, wc) > F.tableDigitRatio) return { keep: false, reason: 'table-text' };
    if (wc >= F.textFragMinWords && area < F.textFragMaxArea) return { keep: false, reason: 'text-fragment' };
    return { keep: true, wc };
  };
}

function isTocPage(half, isNoise) {
  const lines = half.lines.filter((l) => !isNoise(l));
  if (lines.length < 8) return false;
  const toc = lines.filter((l) => /(\.\s*){2,}.*\d{1,3}\s*$/.test(cleanText(l.text)));
  return toc.length >= Math.max(5, lines.length * 0.3);
}

// Rebuild a line's internal spacing from word x-positions (for contents pages).
function makeLayoutLine(C) {
  const L = C.layoutLine;
  return function layoutLine(l, minX) {
    const ws = (l.words || []).filter((w) => alnum(w.text) > 0);
    if (!ws.length) return null;
    let out = ' '.repeat(Math.max(0, Math.min(L.maxIndent, Math.round((ws[0].bbox.x0 - minX) / L.pxPerChar))));
    out += ws[0].text;
    for (let i = 1; i < ws.length; i++) {
      const gap = ws[i].bbox.x0 - ws[i - 1].bbox.x1;
      const sp = Math.max(1, Math.min(L.maxSpaces, Math.round(gap / L.pxPerChar)));
      out += ' '.repeat(sp) + ws[i].text;
    }
    return out;
  };
}

function makeColumnBlocks(ctx, joinLines, C) {
  return function columnBlocks(lines) {
    const blocks = [];
    const body = lines.filter((l) => !makeIsNoise(C)(l)).sort((a, b) => a.bbox.y0 - b.bbox.y0);
    if (!body.length) return blocks;
    const isNoise = makeIsNoise(C);
    const medH = median(body.map((l) => l.bbox.y1 - l.bbox.y0));
    const pitches = [];
    for (let i = 1; i < body.length; i++) pitches.push(body[i].bbox.y0 - body[i - 1].bbox.y0);
    const medPitch = median(pitches.filter((p) => p > 3)) || medH * 1.12;
    const leftMost = median(body.map((l) => l.bbox.x0)) || 0;
    const leftMargin = pct(body.map((l) => l.bbox.x0), 0.15);
    const colWidth = median(body.map((l) => l.bbox.x1 - l.bbox.x0)) || ctx.width;

    const tocLines = body.filter((l) => /(\.\s*){2,}.*\d{1,3}\s*$/.test(cleanText(l.text)));
    const isToc = tocLines.length >= Math.max(5, body.length * 0.3);

    let para = [], paraY = 0;
    const flush = () => { if (para.length) { blocks.push({ type: 'p', text: joinLines(para), y: paraY }); para = []; } };

    for (let i = 0; i < body.length; i++) {
      const l = body[i];
      const t = cleanText(l.text);
      if (!t) continue;
      if (isToc) { if (alnum(t) >= 3) blocks.push({ type: 'toc', text: t, y: l.bbox.y0 }); continue; }
      const y0 = l.bbox.y0;
      const prev = body[i - 1], next = body[i + 1];
      const gapBefore = prev ? y0 - prev.bbox.y0 : 999;
      const gapAfter = next ? next.bbox.y0 - y0 : 999;
      const width = l.bbox.x1 - l.bbox.x0;
      const caps = isAllCaps(t);
      const words = t.split(/\s+/).length;
      const centered = Math.abs((l.bbox.x0 + l.bbox.x1) / 2 - ctx.center) < ctx.width * 0.1 && width < ctx.width * 0.75;
      const starter = /^(PART|SECTION|STEP|CHAPTER|APPENDIX|NOTE|CONCLUSION|INTRODUCTION)\b/i.test(t);
      const itemHead = /^(\(?[A-Z0-9]{1,3}[).]|No\.\s?\d+|\(?[a-z]\))\s+\S/.test(t);
      const shortLine = width < colWidth * 0.8;
      const nAlpha = (t.match(/[A-Za-z]/g) || []).length;
      const headingish = (() => {
        const startsUpper = !/^[a-z]/.test(t);
        const endsOpen = !/[.,;:]$/.test(t);
        const spaceAfter = gapAfter > medPitch * 1.15;
        const spaceBefore = gapBefore > medPitch * 1.1;
        if (!startsUpper || !spaceAfter) return false;
        if (t.length > 70 || nAlpha < 3 || words > 12) return false;
        if (/^Step\b/i.test(t) && /\b(No\.|Page|Trick)\b/i.test(t)) return false;
        if (/(\.\s*){2,}.*\d{1,3}\s*$/.test(t)) return false;
        if (/^\(.*\)$/.test(t)) return false;
        if (caps && spaceBefore && !/\.$/.test(t)) return true;
        if (starter && endsOpen) return true;
        if (itemHead && spaceBefore) return true;
        if (centered && spaceBefore && endsOpen && t.length <= 50 && width < colWidth * 0.62) return true;
        if (shortLine && t.length <= 52 && endsOpen && spaceBefore) return true;
        return false;
      })();
      if (headingish) {
        flush();
        let level = 3;
        if (/^(STEP|CHAPTER)\b/i.test(t)) level = 1;
        else if (/^(PART|SECTION|APPENDIX)\b/i.test(t)) level = 2;
        else if (caps) level = 2;
        else if (itemHead) level = 4;
        blocks.push({ type: 'h', level, text: t, y: y0 });
        continue;
      }
      const indentAmt = l.bbox.x0 - leftMargin;
      const nextFlush = next ? Math.abs(next.bbox.x0 - leftMargin) <= 7 : true;
      const firstLineIndent = indentAmt > Math.max(7, medH * 0.4) && nextFlush;
      const newPara = para.length && (gapBefore > medPitch * 1.32 || firstLineIndent);
      if (newPara) flush();
      if (!para.length) paraY = y0;
      para.push(t);
    }
    flush();
    return blocks;
  };
}

function maskWords(lines, figBoxes) {
  return lines.map((l) => {
    const ws = (l.words || []).filter((w) => {
      const cx = (w.bbox.x0 + w.bbox.x1) / 2, cy = (w.bbox.y0 + w.bbox.y1) / 2;
      return !figBoxes.some((b) => cx >= b.x0 - 2 && cx <= b.x1 + 2 && cy >= b.y0 - 2 && cy <= b.y1 + 2);
    });
    if (!ws.length) return null;
    return {
      text: ws.map((w) => w.text).join(' '),
      conf: ws.reduce((s, w) => s + w.conf, 0) / ws.length,
      bbox: { x0: Math.min(...ws.map((w) => w.bbox.x0)), x1: Math.max(...ws.map((w) => w.bbox.x1)), y0: l.bbox.y0, y1: l.bbox.y1 },
      words: ws,
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------- page build
function makeBuildPage(cfg, helpers) {
  const { isNoise, trimHalfLines: trim, cleanText: cl, detachPageNumber: dpn, detectColumns: dc, columnBlocks: cb, isTocPage: itp, layoutLine, joinLines: jl, filterFigure, titlePages, duplicatePages } = helpers;
  const C = cfg.assemble;
  return function buildPage(j, figList) {
    const blocks = [], nums = [];
    const dup = duplicatePages && duplicatePages[String(j.page)];
    if (dup) return { page: j.page, blocks: [], nums: [], duplicate: dup };
    const pageWords = j.halves.flatMap((h) => h.lines.flatMap((l) => l.words || []));
    const indexLike = pageWords.length > 60 && pageWords.filter((w) => /^\d{1,4}[,–-]?$/.test(w.text)).length / pageWords.length > 0.08;
    const pageInfo = { indexLike };
    const kept = [];
    for (const f of figList) {
      const half = j.halves.find((h) => h.side === f.side);
      if (!half) continue;
      const r = filterFigure(f, half, pageInfo);
      if (r.keep) kept.push(f);
    }
    for (const half of j.halves) {
      const hfigs = kept.filter((f) => f.side === half.side);
      // Title pages: display type rendered line-by-line, no paragraph flow.
      if (titlePages.has(j.page) && half.side === 'R') {
        const trimmed = trim(half.lines);
        const lines = trimmed.filter((l) => {
          const t = cl(l.text);
          if (isNoise(l) || alnum(t) < 3) return false;
          if (l.conf >= C.conf.titlePageMinConf) return true;
          return j.page === 1 && l.conf >= C.conf.titlePageCoverConf && /^[A-Z][A-Za-z'’.\- ]{3,}$/.test(t) && !/\d/.test(t);
        }).sort((a, b) => a.bbox.y0 - b.bbox.y0);
        const rows = [];
        for (const l of lines) {
          const t = cl(l.text);
          const prev = rows[rows.length - 1];
          if (prev && Math.abs(l.bbox.y0 - prev.y0) < C.titleMergeY && (l.bbox.y0 + l.bbox.y1) / 2 - prev.y1 < C.titleMergeOverlap) {
            prev.text += ' ' + t; prev.y1 = l.bbox.y1;
          } else rows.push({ text: t, y0: l.bbox.y0, y1: l.bbox.y1, y: l.bbox.y0 });
        }
        for (const r of rows) blocks.push({ type: 'line', text: r.text, y: r.y, side: half.side });
        for (const f of hfigs) blocks.push({ type: 'fig', fig: f, y: half.box.top + f.rel.y0 - 2, side: half.side });
        continue;
      }
      const trimmed = trim(half.lines);
      const { nums: hn, keep } = dpn(trimmed, half.box.height, C);
      nums.push(...hn);
      const lines = maskWords(keep, hfigs.map((f) => f.rel));
      if (!lines.length && !hfigs.length) continue;
      const ctx = { width: half.box.width, center: half.box.width / 2 };
      if (itp(half, isNoise) && lines.length >= 8) {
        const sorted = lines.filter((l) => !isNoise(l)).map((l) => ({
          ...l,
          words: (l.words || []).filter((w) => !(w.conf < C.conf.tocWordDropConf && (alnumRatio(w.text) < 0.6 || w.text.length <= 1))),
        })).filter((l) => l.words.length).sort((a, b) => a.bbox.y0 - b.bbox.y0);
        const minX = Math.min(...sorted.map((l) => (l.words && l.words[0] ? l.words[0].bbox.x0 : l.bbox.x0)));
        const rows = sorted.map((l) => layoutLine(l, minX)).filter(Boolean);
        blocks.push({ type: 'layout', rows, y: half.box.top - 1, side: half.side });
        continue;
      }
      const cut = dc(lines, half.box.width, C);
      if (cut) {
        const { left, right, full } = (() => {
          const L = [], R = [], F = [];
          for (const l of lines) {
            const ws = l.words || [];
            let gi = -1, gb = 1e9;
            for (let i = 1; i < ws.length; i++) {
              const g = ws[i].bbox.x0 - ws[i - 1].bbox.x1;
              const c = (ws[i - 1].bbox.x1 + ws[i].bbox.x0) / 2;
              if (Math.abs(c - cut) < gb) { gb = Math.abs(c - cut); gi = i; }
            }
            const gap = gi > 0 ? ws[gi].bbox.x0 - ws[gi - 1].bbox.x1 : 0;
            const mk = (sub) => ({ text: sub.map((w) => w.text).join(' '), conf: sub.reduce((s, w) => s + w.conf, 0) / sub.length, bbox: { x0: Math.min(...sub.map((w) => w.bbox.x0)), x1: Math.max(...sub.map((w) => w.bbox.x1)), y0: l.bbox.y0, y1: l.bbox.y1 }, words: sub });
            if (gi > 0 && gb <= 30 && gap >= 13) { L.push(mk(ws.slice(0, gi))); R.push(mk(ws.slice(gi))); }
            else F.push(mk(ws));
          }
          return { left: L, right: R, full: F };
        })();
        const lb = cb(left, ctx), rb = cb(right, ctx), fb = cb(full, ctx);
        const lToc = lb.filter((b) => b.type === 'toc').length > lb.length * 0.6 && lb.length > 2;
        const rToc = rb.filter((b) => b.type === 'toc').length > rb.length * 0.6 && rb.length > 2;
        if (lToc && rToc) blocks.push({ type: 'toc2', left: lb, right: rb, full: fb, y: half.box.top - 1, side: half.side });
        else {
          blocks.push({ type: 'col', blocks: fb, y: half.box.top - 1, side: half.side, col: 0 });
          blocks.push({ type: 'col', blocks: lb, y: half.box.top, side: half.side, col: 1 });
          blocks.push({ type: 'col', blocks: rb, y: half.box.top, side: half.side, col: 2 });
        }
      } else {
        for (const b of cb(lines, ctx)) { b.side = half.side; blocks.push(b); }
      }
      for (const f of hfigs) blocks.push({ type: 'fig', fig: f, y: half.box.top + f.rel.y0 - 2, side: half.side });
    }
    const order = { L: 0, R: 1 };
    blocks.sort((a, b) => (order[a.side] - order[b.side]) || (a.y - b.y));
    return { page: j.page, blocks, nums: [...new Set(nums)] };
  };
}

// Printed folios drift from the naive scan→book mapping (dropped/repeated
// spreads). Calibrate per page from page numbers OCR found at the foot of each
// half, taking the local mode with own-votes weighting.
function calibrateOffsets(jsons) {
  const det = new Map();
  for (const j of jsons) {
    const votes = [];
    const spread = j.geom && j.geom.mode === 'spread';
    for (const h of j.halves) {
      const cand = (h.lines || []).filter((l) =>
        /^\d{1,3}$/.test(l.text.trim()) && l.conf > 70 &&
        l.bbox.y0 > h.box.height * 0.86 && (l.bbox.y1 - l.bbox.y0) < 30);
      if (cand.length !== 1) continue;
      const n = +cand[0].text.trim();
      votes.push(spread
        ? n - (2 * j.page - 2 + (h.side === 'R' ? 1 : 0))
        : n - j.page);
    }
    if (votes.length) det.set(j.page, votes);
  }
  const off = new Map();
  let last = 0;
  for (const j of jsons) {
    const pool = [];
    const own = det.get(j.page);
    if (own) for (let k = 0; k < C_FOLIO_OWN_VOTES; k++) pool.push(...own);
    for (let d = -C_FOLIO_NEIGHBORS; d <= C_FOLIO_NEIGHBORS; d++) {
      if (d === 0) continue;
      const v = det.get(j.page + d);
      if (v) pool.push(...v);
    }
    if (pool.length) {
      const c = {};
      pool.forEach((x) => { c[x] = (c[x] || 0) + 1; });
      const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
      last = +best[0];
    }
    off.set(j.page, last);
  }
  return off;
}
let C_FOLIO_OWN_VOTES = 5, C_FOLIO_NEIGHBORS = 3;

function scanToBook(scan, off, spread) {
  const o = off.get(scan) || 0;
  return spread ? [2 * scan - 2 + o, 2 * scan - 1 + o] : [scan + o, scan + o];
}

function makeCaptionFor() {
  return function captionFor(pg, fig) {
    const all = [];
    const walk = (bs) => { for (const b of bs) { if (b.type === 'col' || b.type === 'toc2') walk(b.blocks || b.left || []); else all.push(b); } };
    walk(pg.blocks.filter((b) => b.side === fig.side && b.type !== 'fig'));
    const below = all.filter((b) => b.y > fig.y && b.type === 'p').sort((a, b) => a.y - b.y)[0];
    const above = all.filter((b) => b.y < fig.y && b.type === 'p').sort((a, b) => b.y - a.y)[0];
    const pick = below && below.y - fig.y < 120 ? below : (above && fig.y - above.y < 60 ? above : null);
    if (!pick) return '';
    const t = pick.text.replace(/\s+/g, ' ').trim();
    if (/^diagram|^fig|^illustration|^the (diagram|illustration)/i.test(t)) return t.slice(0, 200);
    return t.length < 110 && /[.:]$/.test(t) ? t : '';
  };
}

// ---------------------------------------------------------------- main run
async function run(ocrDir, pagesDir, figuresDir, outDir, cfg, meta) {
  const A = cfg.assemble;
  C_FOLIO_OWN_VOTES = A.folioOwnVotes;
  C_FOLIO_NEIGHBORS = A.folioNeighbors;
  const fixGlyphs = makeFixGlyphs(A.replacements);
  const helpers = {
    isNoise: makeIsNoise(A),
    trimHalfLines: (lines) => trimHalfLines(lines, A),
    cleanText,
    detachPageNumber: (lines, boxH) => detachPageNumber(lines, boxH, A),
    detectColumns: (lines, width) => detectColumns(lines, width, A),
    columnBlocks: null, // filled below (needs joinLines)
    isTocPage: (half, isN) => isTocPage(half, isN),
    layoutLine: makeLayoutLine(A),
    joinLines: makeJoinLines(fixGlyphs),
    filterFigure: makeFilterFigure(A),
    titlePages: new Set(A.titlePages || []),
    duplicatePages: A.duplicatePages || null,
  };
  helpers.columnBlocks = (lines, ctx) => makeColumnBlocks(ctx, helpers.joinLines, A)(lines);
  const buildPage = makeBuildPage(cfg, helpers);
  const captionFor = makeCaptionFor();

  const figRaw = JSON.parse(fs.readFileSync(path.join(outDir, 'cache', 'figures.json'), 'utf8'));
  const figMap = new Map(figRaw.map((p) => [p.page, p.figures]));

  fs.rmSync(figuresDir, { recursive: true, force: true });
  fs.mkdirSync(figuresDir, { recursive: true });

  const files = fs.readdirSync(ocrDir).filter((f) => /^page-\d+\.json$/.test(f)).sort();
  const jsons = files.map((f) => JSON.parse(fs.readFileSync(path.join(ocrDir, f), 'utf8')));
  const off = calibrateOffsets(jsons);
  const pages = jsons.map((j) => buildPage(j, figMap.get(j.page) || []));

  // name figures in flow order, crop kept ones
  const figureIndex = [];
  for (const pg of pages) {
    let k = 0;
    for (const b of pg.blocks) {
      if (b.type !== 'fig') continue;
      k++;
      b.fig.file = `p${String(pg.page).padStart(3, '0')}-fig${k}.png`;
      figureIndex.push({ page: pg.page, side: b.side, file: b.fig.file, box: b.fig.box, caption: '' });
    }
  }
  for (let i = 0; i < pages.length; i++) {
    const j = jsons[i];
    const img = path.join(pagesDir, j.geom.file);
    for (const b of pages[i].blocks) {
      if (b.type !== 'fig') continue;
      const buf = await sharp(img).extract(b.fig.box)
        .resize({ width: Math.min(2 * b.fig.box.width, 1600), kernel: 'lanczos3' })
        .png({ compressionLevel: 9 }).toBuffer();
      fs.writeFileSync(path.join(figuresDir, b.fig.file), buf);
    }
  }
  for (const pg of pages) for (const b of pg.blocks) {
    if (b.type === 'fig') {
      const cap = captionFor(pg, b);
      b.caption = cap;
      const rec = figureIndex.find((r) => r.file === b.fig.file);
      if (rec) rec.caption = cap;
    }
  }

  const assembled = {
    meta: { ...meta, pagesInSource: jsons.length, generated: new Date().toISOString(), profile: cfg.profileFile },
    spreadMode: jsons.filter((j) => j.geom && j.geom.mode === 'spread').length > 0,
    modes: Object.fromEntries(jsons.map((j) => [j.page, j.geom && j.geom.mode ? j.geom.mode : 'single'])),
    offsets: Object.fromEntries(off),
    pages,
    figureIndex,
  };
  fs.writeFileSync(path.join(outDir, 'assembled.json'), JSON.stringify(assembled));
  const md = renderMarkdown(assembled, cfg);
  fs.writeFileSync(path.join(outDir, 'raw_extracted.md'), md);
  return assembled;
}

// ---------------------------------------------------------------- markdown
function renderMarkdown(assembled, cfg) {
  const { pages, figureIndex, meta, modes, offsets } = assembled;
  const L = [];
  const push = (s = '') => L.push(s);
  const off = new Map(Object.entries(offsets).map(([k, v]) => [+k, v]));
  const isSpread = (p) => modes[p] === 'spread';

  push('---');
  push(`title: "${meta.title}"`);
  push(`author: "${meta.author}"`);
  push(`source: "${meta.source}"`);
  push(`pages_in_source: ${meta.pagesInSource}`);
  const anySpread = Object.values(modes).some((m) => m === 'spread');
  push(`extraction: "${meta.textLayer ? 'text layer' : 'OCR'} of ${anySpread ? 'two-page spreads' : 'single pages'}; layout reconstructed"`);
  push('---');
  push();
  push(`# ${meta.title}`);
  push();
  push(`*by ${meta.author}*`);
  push();
  push(`> **About this file.** Page markers of the form ${'`'}<!-- scan p. N · book pp. X–Y -->${'`'} give the position in the original. Illustration and diagram crops are stored in ${'`'}figures/${'`'} and linked where they occur.`);
  push();
  push('---');
  push();

  const pg0 = (f) => Number(f.replace(/^p(\d+)-.*/, '$1'));

  function renderBlock(b) {
    if (b.type === 'h') {
      const hashes = '#'.repeat(Math.min(6, b.level + 1));
      push(`${hashes} ${b.text}`);
      push();
    } else if (b.type === 'p') {
      push(b.text);
      push();
    } else if (b.type === 'line') {
      push(b.text);
      push();
    } else if (b.type === 'toc') {
      push(`- ${b.text}`);
    } else if (b.type === 'fig') {
      push(`![Figure — scan p. ${pg0(b.fig.file)}](figures/${b.fig.file})`);
      push();
      if (b.caption) { push(`*${b.caption}*`); push(); }
    }
  }

  function renderToc2(b) {
    if (b.full && b.full.length) { for (const f of b.full) renderBlock(f); }
    push('| | |');
    push('|---|---|');
    const n = Math.max(b.left.length, b.right.length);
    for (let i = 0; i < n; i++) {
      const l = b.left[i] ? b.left[i].text.replace(/\|/g, '/') : '';
      const r = b.right[i] ? b.right[i].text.replace(/\|/g, '/') : '';
      push(`| ${l} | ${r} |`);
    }
    push();
  }

  for (const pg of pages) {
    const dup = pg.duplicate ? scanToBook(pg.duplicate, off, isSpread(pg.duplicate)) : scanToBook(pg.page, off, isSpread(pg.page));
    const [b0, b1] = dup;
    push(`<!-- scan p. ${pg.page} · book pp. ${b0}–${b1}${pg.duplicate ? ' (repeat of scan p. ' + pg.duplicate + ')' : ''} -->`);
    push();
    if (pg.duplicate) {
      push('*This scan page is identical to the previous one — the source PDF repeats the same page. No new text.*');
      push();
      continue;
    }
    for (const b of pg.blocks) {
      if (b.type === 'col') { renderBlocks(b.blocks); continue; }
      if (b.type === 'layout') {
        push('```text');
        for (const r of b.rows) push(r.replace(/\s+$/, ''));
        push('```');
        push();
        continue;
      }
      if (b.type === 'toc2') { renderToc2(b); continue; }
      renderBlock(b);
    }
    push();
  }

  if (cfg.assemble.includeFigureIndex !== false) {
    push('---');
    push();
    push('## Extracted figures and diagrams');
    push();
    push(`${figureIndex.length} illustrations, diagrams and detected graphic regions were cropped from the page images.`);
    push();
    push('| # | File | Scan page | Book page |');
    push('|--:|------|----------:|----------:|');
    figureIndex.forEach((f, i) => {
      const [bp0, bp1] = scanToBook(f.page, off, isSpread(f.page));
      push(`| ${i + 1} | [${f.file}](figures/${f.file}) | ${f.page} | ${isSpread(f.page) ? (f.side === 'L' ? bp0 : bp1) : bp0} |`);
    });
    push();
  }

  return L.join('\n');
}

module.exports = { run, cleanText, calibrateOffsets };
