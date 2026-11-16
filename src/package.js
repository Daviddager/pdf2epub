// Stage 8: compile the epub/ skeleton into a single .epub zip archive.
// mimetype must be the FIRST entry and stored uncompressed (OCF requirement);
// everything else is deflated. Deterministic (sorted) entry order after that.
'use strict';
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function slug(s) {
  return (s || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'book';
}

async function run(outDir, meta) {
  const epubDir = path.join(outDir, 'epub');
  const outFile = path.join(outDir, `${slug(meta.title)}.epub`);
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  const entries = [];
  entries.push({ name: 'mimetype', abs: path.join(epubDir, 'mimetype'), store: true });
  const walk = (dir, base) => {
    for (const f of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, f);
      const rel = base ? `${base}/${f}` : f;
      if (fs.statSync(abs).isDirectory()) walk(abs, rel);
      else if (rel !== 'mimetype') entries.push({ name: rel, abs, store: false });
    }
  };
  walk(epubDir, '');

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver('zip', { store: false, zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const e of entries) {
      archive.append(fs.createReadStream(e.abs), { name: e.name, store: e.store });
    }
    archive.finalize();
  });

  const size = fs.statSync(outFile).size;
  return { file: outFile, size, entries: entries.length };
}

module.exports = { run, slug };

if (require.main === module) {
  run(process.argv[2], JSON.parse(process.argv[3] || '{}')).then(
    (r) => console.log(JSON.stringify(r)),
    (e) => { console.error(e); process.exit(1); });
}
