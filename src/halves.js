// Shared: split a page into OCR/reading halves at the gutter.
// Spread pages get L + R halves; single pages get one half covering the content.
'use strict';

function halvesOf(g, pad = 4) {
  const y0 = Math.max(0, g.top - pad), y1 = Math.min(g.h, g.bot + pad);
  if (g.mode === 'single' || !g.spread) {
    return [{ side: 'L', box: { left: g.left, top: y0, width: Math.max(1, g.right - g.left), height: y1 - y0 } }];
  }
  const gut = g.gutter;
  return [
    { side: 'L', box: { left: Math.max(0, g.left - pad), top: y0, width: gut - Math.max(0, g.left - pad), height: y1 - y0 } },
    { side: 'R', box: { left: gut, top: y0, width: Math.min(g.w, g.right + pad) - gut, height: y1 - y0 } },
  ].map((h) => ({ ...h, box: { ...h.box, width: Math.min(h.box.width, g.w - h.box.left) } }));
}

module.exports = { halvesOf };
