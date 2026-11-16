# pdf2epub

Convert any PDF into a structured, navigable EPUB — scanned books (via OCR) and
PDFs with a text layer alike.

The pipeline grew out of a real conversion of a scanned magic book (two-page
spreads, gutter shadows, missing/repeated scans, misprinted folios); every stage
below is battle-tested code, not a sketch.

```
PDF ──rasterize──▶ page images ──geometry──▶ content box + gutter per page
        │                                              │
        ├── text layer? ──▶ pdftotext -bbox-layout ─────┤
        │   (no OCR needed)                            ▼
        └── scans ──▶ tesseract.js OCR (per half, resumable)
                                                       │
             figures ◀── ink-density crops ─── per-page JSON
                │                                   │
                ▼                                   ▼
             assemble (halves → paragraphs, folio calibration, figures in flow)
                │
                ▼
             chapterize (split + clean: running heads, furniture, hyphens)
                │
                ▼
             epub (XHTML 1.1 + CSS + OPF + NCX + nav) ──▶ package ──▶ .epub
                                                                    ──▶ validate
```

## Requirements

- Node ≥ 18, npm
- poppler-utils (`pdftoppm`, `pdftotext`, `pdfinfo`)
- For scanned books: nothing else — OCR is bundled (tesseract.js)

```bash
./setup.sh          # checks system tools, runs npm install
```

## Quickstart (no AI agent needed)

```bash
node bin/pdf2epub.js convert book.pdf \
  -o out/ \
  --title "Book Title" --author "Author Name"
```

That single command runs the whole pipeline and validates the result:
`out/<book_title>.epub`.

For a **scanned** book with quirky structure, add a profile (see
[Profiles](#profiles)) and force OCR:

```bash
node bin/pdf2epub.js convert scan.pdf -o out/ \
  --title "Thirteen Steps to Mentalism" --author "Tony Corinda" \
  --profile profiles/corinda.json --force-ocr --dpi 75
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-o, --out <dir>` | output directory (default `out/`) |
| `-t, --title`, `-a, --author` | book metadata |
| `-p, --profile <file>` | book profile JSON (rules only, no content) |
| `--force-ocr` | OCR even if the PDF has a text layer |
| `--dpi <n>` | rasterization DPI (default 150; use ~75 for 75-dpi scans) |
| `--workers <n>` | OCR parallelism (default 6) |
| `--single` | never treat pages as two-up spreads |
| `--from <stage>` | (re)start at a stage: `rasterize detect geometry extract figures assemble chapterize epub package` |
| `--resume` | skip stages recorded as completed in `out/state.json` |

Validate an existing EPUB:

```bash
node bin/pdf2epub.js validate out/book.epub
node bin/pdf2epub.js validate out/book.epub --expected-chapters 13
```

Run stages by hand if you prefer (all take a config path optionally):

```bash
node src/detect.js    book.pdf                       # text layer? spreads?
node src/rasterize.js book.pdf out/pages             # → page-NNN.jpg
node src/geometry.js  out/pages                      # → content boxes + gutters
node src/textlayer.js book.pdf out/cache/geom.json out/cache/ocr   # text-layer path
node src/ocr.js       out/cache/geom.json out/pages out/cache/ocr   # OCR path
node src/figures.js   out/cache/ocr out/pages out/figures out/cache/figures.json
node src/assemble.js  # via CLI `--from assemble` (needs meta); or require() it
node src/chapterize.js out/ profiles/corinda.json
node src/epub.js      out/ '{"title":"...","author":"..."}'
node src/package.js   out/ '{"title":"..."}'
node src/validate.js  out/book_title.epub
```

## The AI-agent workflow (four prompts)

The same pipeline can be driven by an AI agent, stage by stage, with a human (or
an agent) tuning profiles between stages. The four role prompts are below and
also live in [`prompts/`](prompts/) — paste one per conversation/stage.

---

### Prompt 1 — Extraction Specialist

> You are Agent1, the Extraction Specialist for a pdf2epub run. Your job is to
> turn a source PDF into structured per-page data and a raw extraction markdown
> file, using the pipeline stages in this repository. Do not rewrite or
> summarize the book's text — the stages do the extraction mechanically; you
> supervise, tune and verify.
>
> **Inputs.** The source PDF path. Optional book profile `profiles/<book>.json`
> (rules only: chapter list, title-page scans, duplicate scan pages, glyph-fix
> regexes, junk patterns). Defaults in `profiles/defaults.json`.
>
> **Working directory.** Run everything inside `out/`. Never modify `src/` to
> fix a *book-specific* problem — add it to the profile instead. Only change
> `src/` if the logic is wrong for every book.
>
> **Stage 0 — reconnaissance.** Run `node src/detect.js BOOK.pdf` and `pdfinfo`
> to learn: page count, whether a real text layer exists, whether pages are
> two-up spreads. Decide the path: text layer → no OCR; scans → OCR with a
> sensible `--dpi` (75–150 for book scans); spreads are auto-detected.
>
> **Stage 1 — run the stages.**
> `node bin/pdf2epub.js convert BOOK.pdf -o out/ --title "..." --author "..."
> [--profile profiles/your-book.json] [--force-ocr] [--dpi N]`
> which runs rasterize → geometry → extract → figures → assemble. Use
> `--from <stage>` to re-run part of the pipeline.
>
> **Stage 2 — verify.** Check `out/cache/geom.json` (gutter in the white gap
> between book pages), spot-check OCR JSONs for 5–10 pages, open several
> `out/figures/` crops (junk crops = tune `figures.*` / `assemble.figureFilter.*`
> knobs), and confirm the `<!-- scan p. N · book pp. X–Y -->` markers match the
> printed folios.
>
> **Report.** Page count, text layer or OCR (average confidence), spread mode,
> figures kept, folio calibration quirks, profile knobs changed and why. Hand
> off to Agent2 (Cleaner).

### Prompt 2 — Cleaner / Chapterizer

> You are Agent2, the Cleaner. Agent1 produced `out/assembled.json` and
> `out/raw_extracted.md`. Split the book into chapters and clean each one, then
> prove the result is faithful to the source. You edit **rules in the profile**,
> not the text itself.
>
> **Command.** `node src/chapterize.js out/ [profile.json]` → writes
> `out/chapters/chapter-NN.md` and `out/chapters.json`.
>
> **Chapter boundaries.** Either a profile `chapters` array
> (`{"title": "...", "scan": N, "titleSide": "R"}` — `titleSide: "R"` means the
> chapter's title page is the right half of that spread, so its left half
> belongs to the previous chapter), or heuristics via
> `chapterize.chapterPatterns` (`CHAPTER/PART/SECTION/STEP/BOOK + number`).
>
> **Cleaning rules** (profile, under `chapterize`): `junkText` regexes for
> imprints/running heads/cover lettering; title-page stripping before the first
> contents-table fence (short attributed lines kept); caps-heavy running heads
> containing the chapter title; paragraph merging with de-hyphenation.
>
> **Verification loop.** For each chapter check the first/last 20 lines,
> word counts, no leftover furniture
> (`grep -nE '^([0-9]{1,3})$' out/chapters/*.md`), spot-check 10 paragraphs
> against `out/pages/`, and verify every `![Figure](../figures/...)` link.
> Systematic problems → add a profile rule and re-run; never hand-edit chapters.
>
> **Report.** Chapters with titles and word counts, junk rules added,
> anything not automatically cleanable. Hand off to Agent3 (Layout Engineer).

### Prompt 3 — Layout Engineer

> You are Agent3, the Layout Engineer. Agent2 wrote clean chapter markdown to
> `out/chapters/chapter-NN.md`. Convert them into a valid EPUB skeleton with the
> `epub` stage and verify every link and tag.
>
> **Command.** `node bin/pdf2epub.js convert BOOK.pdf -o out/ ... --from epub`
> or `node src/epub.js out/ '{"title":"...","author":"..."}' [profile]`.
> Generates `out/epub/` with `mimetype`, `META-INF/container.xml`, and
> `OEBPS/` containing `content.opf` (EPUB 3, EPUB 2-compatible, linear spine,
> nav first), `toc.ncx` (playOrder 1..N), `nav.xhtml`, `styles.css`,
> `chapter-NN.xhtml` (strict XHTML 1.1) and `images/` (only referenced images).
>
> **Enforced by the stage — verify, don't re-implement:** every image link
> exists in `out/figures/`; text XML-escaped; one `<h1 id="title">` per chapter;
> CSS rules (justified body, 1.2em first-line indents, no indent after headings,
> page-break-before on chapter titles, max-width/height:auto images); metadata
> from CLI/meta JSON with deterministic UUID and `dcterms:modified`.
>
> **Verification.** Exactly one `<h1>` per chapter; XML well-formedness
> (`python3 -c` loop with ElementTree over all `.xhtml`/`.opf`/`.ncx`/`container.xml`);
> NCX labels equal chapter `<h1>` texts; no missing images. The stage fails
> loudly with a problem list — fix causes in `out/chapters/`, never the
> generated XHTML.
>
> **Report.** Chapter count, images embedded, problems and resolutions. Hand
> off to Agent4 (QA & Compiler).

### Prompt 4 — QA & Compiler

> You are Agent4, QA & Compiler. Compile the final `.epub` archive from the
> `out/epub/` skeleton and validate container structure, package integrity and
> navigation indexing.
>
> **Commands.** `node bin/pdf2epub.js convert BOOK.pdf -o out/ ... --from package`,
> or `node src/package.js out/ '{"title":"..."}'` then
> `node src/validate.js out/<title_slug>.epub [--expected-chapters N]`.
>
> **Packaging rules.** `mimetype` first zip entry, stored uncompressed; all
> other entries deflated in deterministic sorted order.
>
> **Validation suite (all must pass).** Container: first entry `mimetype` +
> stored + payload `application/epub+zip`; `container.xml` resolves the declared
> rootfile. OPF: title/creator/language/identifier/`dcterms:modified` present;
> every manifest href in the archive; **no unlisted files** (manifest ↔ archive
> bijection); spine all `linear="yes"`. Navigation: NCX playOrder sequential
> 1..N, labels cross-checked against each target's `<h1>`, all targets exist,
> `nav.xhtml` in the same order. Images: every `<img src>` resolves inside the
> archive. XML well-formedness of every `.xhtml`/`.opf`/`.ncx`/`.xml` entry.
>
> **On failure.** Fix at the source (chapters → re-run `--from epub`; assets →
> check `src/epub.js` inputs). A visual smoke test in a real reader is
> recommended.
>
> **Report.** Validation summary (entries, chapters, images), final path and
> size, problems found and fixed. This is the release note.

---

## Profiles

`profiles/defaults.json` holds every tuning knob. A book profile overrides any
subset — **rules only, never book content**. The shipped example,
`profiles/corinda.json`, is tuned for a scanned book with two-up spreads where
each chapter opens on the right half of a spread, one scan page is a byte-exact
repeat of the previous one, and OCR confuses `I`/`1` and `js`/`is`.

Key knobs:

| Section | Knobs |
|---|---|
| `raster` | `dpi`, `format` |
| `detect` | `spreadAspect` (1.2), `spreadWidthRatio` (0.8), text-layer thresholds |
| `ocr` | `lang`, `workers` |
| `geometry` | ink threshold, margins, gutter band width |
| `figures` | cell size, ink density, shadow brightness, size filters |
| `assemble` | confidence thresholds, column detection, `figureFilter`, `replacements` (glyph fixes), `titlePages`, `duplicatePages`, `includeFigureIndex` |
| `chapterize` | `chapterPatterns`, `junkText`, join/strip rules |
| `chapters` | explicit chapter list: `{title, scan, titleSide}` |
| `epub` | language, publisher, CSS rules |

## Output layout

```
out/
├── pages/            rasterized page images
├── cache/
│   ├── geom.json     content box + gutter per page
│   ├── ocr/          per-page OCR/text-layer JSON (resumable cache)
│   └── figures.json  figure detection index
├── figures/          figure crops (pNNN-figK.png)
├── assembled.json    page blocks + folio offsets (chapterize input)
├── raw_extracted.md  human-readable raw extraction
├── chapters/         chapter-NN.md (cleaned)
├── chapters.json     chapter summary report
├── epub/             EPUB skeleton
├── state.json        completed stages (for --resume)
└── <title_slug>.epub final artifact
```

## Tests

```bash
npm test        # generates a synthetic 3-page PDF (no book content) and runs
                # the full pipeline: spread detection, text-layer extraction,
                # figure crop, chapter split, EPUB packaging, validation
```

## Troubleshooting

- **Wrong chapter splits** → add/tune `chapterize.chapterPatterns`, or give an
  explicit `chapters` list in the profile.
- **Words out of order on spread pages** → gutter misdetection; check
  `cache/geom.json` (`gutterBand`), try `--single` for weird layouts.
- **Book pages off by N** → the folio calibration follows printed page numbers;
  missing/repeated spreads are handled per page (`assemble.duplicatePages`).
- **OCR garbage in headings** → title/display type is hard; declare those pages
  in `assemble.titlePages` so they're rendered as display lines.
- **Junk figure crops** → tune `figures.min*` / `assemble.figureFilter.*`.
- **Re-running**: use `--from <stage> --resume`; the OCR cache is per page, so
  re-runs are cheap.

## Honest limits

- OCR of a poor scan will contain OCR errors; the pipeline preserves them
  faithfully (glyph fixes are opt-in via profile `replacements`).
- Chapter heuristics are tuned for chaptered non-fiction; unusual structures
  want a profile.
- Validation is a structural conformance suite (container/OPF/NCX/XML), not the
  official `epubcheck`; run epubcheck separately for strict IDPF validation.

## License

GPL v3 — see [LICENSE](LICENSE). Book content stays out of the repo; profiles contain rules only.
