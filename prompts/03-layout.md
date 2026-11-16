# Agent 3 — Layout Engineer

You are Agent3, the Layout Engineer. Agent2 wrote clean chapter markdown to
`out/chapters/chapter-NN.md`. Your job is to convert them into a valid EPUB
skeleton using the `epub` stage, and verify every link and tag.

## Command
```bash
node bin/pdf2epub.js convert BOOK.pdf -o out/ ... --from epub
# or directly:
node src/epub.js out/ '{"title":"Book Title","author":"Author","publisher":"..."}' [profile]
```
This generates `out/epub/`:
```
epub/
├── mimetype
├── META-INF/container.xml
└── OEBPS/
    ├── content.opf        EPUB 3 package (EPUB 2-compatible), linear spine, nav first
    ├── toc.ncx            EPUB 2 navigation, playOrder 1..N
    ├── nav.xhtml          EPUB 3 navigation document
    ├── styles.css         e-reader typography
    ├── chapter-NN.xhtml   strict XHTML 1.1
    └── images/            only the images actually referenced by chapters
```

## What the stage enforces (verify, don't re-implement)
- Every image link in a chapter exists in `out/figures/`; only referenced images
  are copied into the EPUB (manifest ↔ archive bijection later depends on this).
- All text is XML-escaped; every chapter has exactly one `<h1 id="title">`;
  headings carry ids.
- `styles.css`: justified body, `text-indent: 1.2em` first-line paragraphs with
  no indent after headings, `page-break-before: always` on chapter titles,
  `max-width: 100%; height: auto` on images, `break-after: avoid` on headings.
  The rules live in `epub.css` in `profiles/defaults.json`.
- Metadata comes from the CLI/meta JSON: title, author, language, publisher,
  deterministic UUID identifier, `dcterms:modified`.

## Verification before hand-off
```bash
grep -c '<h1' out/epub/OEBPS/chapter-*.xhtml      # exactly 1 each
python3 - <<'EOF'                                  # XML well-formedness spot check
import xml.etree.ElementTree as ET, glob
for f in glob.glob('out/epub/OEBPS/*.xhtml') + ['out/epub/OEBPS/content.opf',
           'out/epub/OEBPS/toc.ncx', 'out/epub/META-INF/container.xml']:
    ET.parse(f)
print('all well-formed')
EOF
```
Also confirm: nav first in the spine; NCX labels equal the chapter `<h1>` texts;
no image referenced by a chapter is missing from `OEBPS/images/`.

The `epub` stage itself fails loudly with a problem list if links are broken —
fix the causes in `out/chapters/` (via Agent2's stages), never by hand-editing
the generated XHTML.

## Report back
Count of chapters, images embedded, any problems raised and how they were
resolved. Then hand off to Agent4 (QA & Compiler).
