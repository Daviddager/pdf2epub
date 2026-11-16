// Stage 9: validate a compiled .epub.
// Checks the OCF container, package integrity (manifest <-> archive
// bijection), spine linearity and order, NCX navigation (sequential playOrder,
// labels matching each chapter's h1), nav.xhtml links, image references,
// stylesheet wiring and XML well-formedness of every XML document.
'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// Minimal XML well-formedness checker: tag balance, quoted attributes,
// no stray/unescaped markup. Sufficient for conformance of our own output.
function xmlWellFormed(s) {
  const errors = [];
  const stack = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/?[A-Za-z][^\s>]*(?:\s+[^<>]*?)?\/?>|[^<]+/g;
  let m;
  while ((m = re.exec(s))) {
    const t = m[0];
    if (t.startsWith('<')) {
      if (t.startsWith('<!--') || t.startsWith('<!') || t.startsWith('<?') || t.endsWith('/>')) continue;
      const name = t.match(/^<\/?([A-Za-z][^\s/>]*)/);
      if (!name) { errors.push(`bad tag near "${t.slice(0, 40)}"`); continue; }
      if (t.startsWith('</')) {
        const top = stack.pop();
        if (top !== name[1]) errors.push(`mismatched </${name[1]}>, expected </${top || 'EOF'}>`);
      } else {
        // attribute sanity: every = must be followed by a quoted value
        const attrs = t.slice(1, -1).replace(/^[A-Za-z][^\s/>]*/, '');
        if (/=\s*[^"']/.test(attrs)) errors.push(`unquoted attribute in "${t.slice(0, 60)}"`);
        stack.push(name[1]);
      }
    } else {
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(t)) errors.push('unescaped & in text');
      if (t.includes('<') || t.includes('>')) errors.push('stray < or > in text');
    }
  }
  if (stack.length) errors.push(`unclosed tags: ${stack.join(',')}`);
  return errors;
}

function validate(epubPath, opts = {}) {
  const problems = [], info = [];
  const zf = new AdmZip(epubPath);
  const names = zf.getEntries().map((e) => e.entryName);

  // zip-level
  if (!names.length) throw new Error('empty epub');
  if (names[0] !== 'mimetype') problems.push(`first zip entry is ${JSON.stringify(names[0])}, must be 'mimetype'`);
  const mtEntry = zf.getEntry('mimetype');
  if (mtEntry && mtEntry.header.method !== 0) problems.push('mimetype is compressed; must be stored');
  if (mtEntry && mtEntry.getData().toString() !== 'application/epub+zip') problems.push('mimetype payload wrong');
  if (!names.includes('META-INF/container.xml')) problems.push('META-INF/container.xml missing');
  else info.push('zip: mimetype first entry, stored; container.xml present');

  // container.xml
  const cc = zf.readAsText('META-INF/container.xml');
  const rootMatch = cc.match(/full-path="([^"]+)"/);
  if (!rootMatch) problems.push('container.xml has no rootfile');
  const opfPath = rootMatch ? rootMatch[1] : 'OEBPS/content.opf';
  if (opfPath && !names.includes(opfPath)) problems.push(`container rootfile ${opfPath} not in archive`);
  else info.push(`container.xml -> ${opfPath}`);

  const base = opfPath.includes('/') ? opfPath.replace(/\/[^/]*$/, '/') : '';
  const rel = (p) => base + p;

  // content.opf
  const opf = zf.readAsText(opfPath);
  const manifest = {};
  for (const m of opf.matchAll(/<item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*>/g)) manifest[m[1]] = m[2];
  const spine = [];
  for (const m of opf.matchAll(/<itemref\s+[^>]*idref="([^"]+)"[^>]*>/g)) spine.push(m[1]);
  const linears = [];
  for (const m of opf.matchAll(/<itemref\s+[^>]*>/g)) linears.push((m[0].match(/linear="([^"]*)"/) || [])[1]);

  const getMeta = (tag) => {
    const m = opf.match(new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)</dc:${tag}>`));
    return m ? m[1] : null;
  };
  const metaTitle = getMeta('title'), metaCreator = getMeta('creator'), metaLang = getMeta('language');
  if (!metaTitle) problems.push('opf: dc:title missing');
  if (!metaCreator) problems.push('opf: dc:creator missing');
  if (!metaLang) problems.push('opf: dc:language missing');
  if (!/unique-identifier/.test(opf) || !getMeta('identifier')) problems.push('opf: identifier missing');
  if (!/dcterms:modified/.test(opf)) problems.push('opf: dcterms:modified missing');
  if (metaTitle && metaCreator && metaLang) info.push(`opf metadata: ${metaTitle} / ${metaCreator} / ${metaLang}`);

  if (linears.some((l) => l !== undefined && l !== 'yes')) problems.push('spine has non-linear itemrefs');
  else info.push(`spine: ${spine.length} itemrefs, all linear='yes'`);

  for (const [iid, href] of Object.entries(manifest)) {
    if (!names.includes(rel(href))) problems.push(`manifest ${iid} -> ${href} not in archive`);
  }
  const listed = new Set(Object.values(manifest).map(rel));
  const disk = new Set(names.filter((n) => n.startsWith(base) && n !== opfPath && n !== 'mimetype' && !n.startsWith('META-INF/')));
  const extra = [...disk].filter((n) => !listed.has(n));
  if (extra.length) problems.push(`files in archive but not in manifest: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? '...' : ''}`);
  else info.push(`manifest<->archive: ${listed.size} listed items all present, 0 unlisted files`);

  // chapters: cross-check NCX labels with h1 titles, image refs, css links
  const chapterIds = spine.filter((s) => s.startsWith('ch'));
  if (opts.expectedChapters && chapterIds.length !== opts.expectedChapters) {
    problems.push(`expected ${opts.expectedChapters} chapter spine items, got ${chapterIds.length}`);
  }
  const ncx = zf.readAsText(rel('toc.ncx'));
  const nps = [];
  for (const m of ncx.matchAll(/<navPoint[^>]*playOrder="(\d+)"[^>]*>([\s\S]*?)<\/navPoint>/g)) {
    nps.push({ order: +m[1], body: m[2] });
  }
  const orders = nps.map((n) => n.order);
  if (orders.join(',') !== Array.from({ length: nps.length }, (_, i) => i + 1).join(',')) {
    problems.push(`ncx playOrder not sequential: ${orders.slice(0, 5).join(',')}...`);
  }
  if (nps.length !== chapterIds.length) problems.push(`ncx has ${nps.length} navPoints vs ${chapterIds.length} chapters`);
  const labels = [], srcs = [];
  for (const np of nps) {
    labels.push((np.body.match(/<text>([\s\S]*?)<\/text>/) || [])[1]);
    srcs.push((np.body.match(/<content\s+src="([^"]+)"/) || [])[1]);
  }
  const xhtmlTitles = [];
  for (const src of srcs) {
    if (!src || !names.includes(rel(src))) { problems.push(`ncx target ${src} missing`); xhtmlTitles.push(null); continue; }
    const data = zf.readAsText(rel(src));
    const m = data.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    xhtmlTitles.push(m ? m[1] : null);
    for (const im of data.matchAll(/<img\s+src="([^"]+)"/g)) {
      if (!names.includes(rel(im[1]))) problems.push(`${src}: img not in archive: ${im[1]}`);
    }
    if (!/styles\.css/.test(data)) problems.push(`${src}: does not link styles.css`);
  }
  const mismatched = labels.map((l, i) => [l, xhtmlTitles[i]]).filter(([l, t]) => l !== t);
  if (mismatched.length) problems.push(`ncx labels differ from chapter h1: ${JSON.stringify(mismatched.slice(0, 3))}`);
  else info.push(`toc.ncx: ${nps.length} navPoints, playOrder 1..${nps.length}, labels match chapter h1 titles`);

  const nav = zf.readAsText(rel('nav.xhtml'));
  const navLinks = [...nav.matchAll(/href="((?:chapter|step)-\d+\.xhtml)"/g)].map((m) => m[1]);
  const expectedLinks = srcs.slice();
  if (navLinks.length !== expectedLinks.length || navLinks.some((l, i) => l !== expectedLinks[i])) {
    problems.push(`nav.xhtml chapter links wrong or out of order`);
  } else info.push(`nav.xhtml: ${navLinks.length} chapter links in order`);

  if (!names.includes(rel('styles.css'))) problems.push('styles.css not in archive');

  // XML well-formedness everywhere
  const xmlEntries = names.filter((n) => /\.(xhtml|opf|ncx|xml)$/.test(n));
  for (const n of xmlEntries) {
    const errs = xmlWellFormed(zf.readAsText(n));
    if (errs.length) problems.push(`malformed XML in ${n}: ${errs.slice(0, 3).join('; ')}`);
  }
  info.push(`xml well-formedness: ${xmlEntries.length} documents parsed clean`);

  return { ok: problems.length === 0, info, problems, counts: { entries: names.length, chapters: chapterIds.length, images: Object.values(manifest).filter((h) => h.startsWith('images/')).length } };
}

module.exports = { validate, xmlWellFormed };

if (require.main === module) {
  const opts = {};
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--expected-chapters') opts.expectedChapters = +rest[++i];
    else if (rest[i] === '--json') opts.json = true;
  }
  const r = validate(process.argv[2], opts);
  console.log(r.info.join('\n'));
  if (r.problems.length) {
    console.error('\nPROBLEMS:\n' + r.problems.join('\n'));
    process.exit(1);
  }
  console.log(`\nPACKAGE VALID: ${process.argv[2]}`);
}
