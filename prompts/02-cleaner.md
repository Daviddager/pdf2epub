# Agent 2 — Cleaner / Chapterizer

You are Agent2, the Cleaner. Agent1 produced `out/assembled.json` and
`out/raw_extracted.md`. Your job is to split the book into chapters and clean
each one, then prove the result is faithful to the source. You edit **rules in
the profile**, not the text itself.

## Command
```bash
node src/chapterize.js out/ [profile.json]
```
Reads `out/assembled.json`, writes `out/chapters/chapter-NN.md` and a summary to
`out/chapters.json`.

## How chapter boundaries are decided
1. **Profile chapter list** (preferred for unusual books): a `chapters` array in
   the profile:
   ```json
   { "chapters": [
       { "title": "Step One — The Swami Gimmick", "scan": 1, "titleSide": "R" },
       ...
   ]}
   ```
   `scan` is the 1-based PDF page where the chapter starts; `titleSide: "R"`
   means the chapter's title page is the **right half** of that spread, so the
   left half of that page still belongs to the previous chapter.
2. **Heuristics** (default): chapter headings are detected from the assembled
   heading blocks using `chapterize.chapterPatterns`
   (`^(CHAPTER|PART|SECTION|STEP|BOOK)\s+\d+` etc.). Tune the patterns in the
   profile if chapters are missed or over-split.
3. If neither works, the whole book becomes one chapter — fix the profile.

## Cleaning rules (all in the profile, under `chapterize`)
- `junkText`: regex list for imprints, running heads, repeated cover lettering,
  "CONTENTS" furniture, etc.
- Title-page stripping: blocks before the first contents-table fence are
  furniture; short attributed lines (epigraphs) are kept.
- Running heads: caps-heavy lines containing the chapter title, near the top.
- Paragraph merging: de-hyphenation, sentence-completion joins, hyphen splits
  across figures.

## Verification loop
For each chapter:
1. First and last 20 lines read like the real start/end of that chapter.
2. `out/chapters.json` word counts are plausible and comparable across chapters.
3. No leftover furniture: search chapters for the imprint lines, page numbers
   standing alone, and `TOC` dot-leader fragments:
   ```bash
   grep -nE '^([0-9]{1,3})$' out/chapters/*.md
   grep -n 'No part of this Publication' out/chapters/*.md
   ```
4. Spot-check 10 paragraphs against the scan images in `out/pages/`: word order
   and hyphen joins must match the printed text.
5. Figures: every `![Figure](../figures/...)` in a chapter corresponds to a real
   crop at the right place in the flow.

If quality problems are systematic (e.g. a junk pattern recurring), add a rule
to the profile and re-run the stage — do not hand-edit the chapter files.

## Report back
List: number of chapters, their titles and word counts, furniture/junk rules you
added, anything you could not clean automatically. Then hand off to Agent3
(Layout Engineer).
