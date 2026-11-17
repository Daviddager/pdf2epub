#!/usr/bin/env bash
# pdf2epub setup: verify system dependencies and install npm packages.
set -euo pipefail
cd "$(dirname "$0")"

fail=0
need() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "ok: $1 $( ("$2" 2>/dev/null || $1 --version 2>/dev/null) | head -1 )"
  else
    echo "MISSING: $1 — install it (e.g. apt-get install $3)"; fail=1
  fi
}

need node    "node --version" nodejs
need pdftoppm "pdftoppm -v"   poppler-utils
need pdftotext "pdftotext -v" poppler-utils

node -e 'const [maj]=process.versions.node.split("."); if(+maj<20){console.log("node >=20 required (LTS lines tested in CI: 22, 24)");process.exit(1)}'

echo "installing npm dependencies..."
npm install
echo
if [ "$fail" = 0 ]; then
  echo "setup complete. Try: node bin/pdf2epub.js --help"
else
  echo "setup finished WITH MISSING SYSTEM TOOLS — see messages above."
  exit 1
fi
