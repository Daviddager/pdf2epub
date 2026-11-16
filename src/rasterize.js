// Stage 1b: rasterize the PDF to page images with pdftoppm.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function imageExt(cfg) {
  return cfg.raster.format === 'jpeg' ? 'jpg' : cfg.raster.format;
}

function rasterize(pdf, outDir, cfg, fromPage, toPage) {
  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    '-r', String(cfg.raster.dpi),
    '-' + cfg.raster.format,
  ];
  if (fromPage) args.push('-f', String(fromPage));
  if (toPage) args.push('-l', String(toPage));
  args.push(pdf, path.join(outDir, 'page'));
  execFileSync('pdftoppm', args, { maxBuffer: 64 * 1024 * 1024 });
  const ext = imageExt(cfg);
  const files = fs.readdirSync(outDir).filter((f) => f.startsWith('page-') && f.endsWith('.' + ext)).sort();
  if (!files.length) throw new Error('pdftoppm produced no images');
  return { files: files.map((f) => ({ file: f, path: path.join(outDir, f) })), ext };
}

module.exports = { rasterize, imageExt };

if (require.main === module) {
  const files = rasterize(process.argv[2], process.argv[3] || 'out/pages', require('./config').loadConfig(process.argv[4]));
  console.log('rasterized', files.length, 'pages ->', process.argv[3] || 'out/pages');
}
