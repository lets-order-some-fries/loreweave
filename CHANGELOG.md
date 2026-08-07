# Changelog

## 0.4.2 — 2026-08-07

- **Frontmatter-only and empty notes are findable.** A note whose entire
  content is frontmatter — a metadata record, a template stub — produced no
  blocks and could not be found by its own title. Its title and scalar
  frontmatter values are now indexed, so both `Marmoset` and `active` find
  `title: Marmoset Index / status: active`. An empty file is likewise findable
  by its filename, which is the same stub workflow.
- **A sweep of note shapes is now a permanent test.** Twelve shapes — code
  block, table, list, frontmatter, heading, MOC, image, single word, CRLF, BOM,
  no trailing newline, blockquote — must each be findable by a word they
  contain, and every note must produce at least one block. This failure mode is
  silent: the note indexes without error, `stats` counts it, and every search
  returns nothing.

## 0.4.1 — 2026-08-07

- **Notes that are only headings are searchable.** A note containing just
  `# Quokka Protocol` produced zero blocks and could not be found by searching
  for its own title. Stub notes — the kind created by following a link before
  writing anything — and index/MOC notes built from headings were entirely
  invisible, while the note count reported them as indexed. A heading with no
  body is now treated as its own content. Measured on a 3-note vault: 1 block
  became 5, and both previously-unfindable notes are found.

## 0.4.0 — 2026-08-07

### CJK vaults now work

Chinese, Japanese and Korean text is written without spaces, so the full-text
tokenizer treated an entire sentence as a single token: a vault of Chinese
notes indexed fine and then returned **nothing** for any query. Searching
`机器学习` against a note containing `这个项目关于机器学习` matched zero rows.

Text handed to the index is now segmented per CJK character, and queries are
segmented the same way, so a query becomes a phrase of character tokens. This
is the standard fallback where a language-specific segmenter is unavailable.

Verified across scripts, with English unchanged:

| script | before | after |
|---|---|---|
| Chinese `机器学习` | no results | found |
| Japanese `機械学習` | no results | found |
| Devanagari `मशीन लर्निंग` | worked | worked |
| accented Latin `stockage durable` | worked | worked |
| English | worked | worked |

Schema v4 adds the exact text given to the index as a stored column, since
per-character segmentation cannot be expressed in the trigger's SQL. Existing
indexes migrate automatically; run `lore index --full` to re-segment old
content.

## 0.3.5 — 2026-08-07

- **`dream` stays quiet when it has nothing to say.** On a densely interlinked
  vault — a Zettelkasten of small atomic notes — every pair co-cites a couple
  of neighbours, so thousands of pairs score almost identically and the "top"
  thirty are arbitrary. Suggestions must now stand clearly above the typical
  candidate. Measured across three real vaults: a 3,000-note Zettelkasten went
  from 30 arbitrary suggestions to 0, while a personal vault kept all 30 of its
  good ones and a docs corpus kept its 9.
- **Windows is a tested platform.** CI now runs Linux, macOS and Windows across
  Node 20 and 22. The product itself passed on the first Windows run; the eval
  harness did not, because dynamic import of an absolute path needs a `file://`
  URL there.

## 0.3.4 — 2026-08-07

- **Notes inside symlinked folders are indexed.** A symlink reports as neither
  file nor directory, so a folder linked into a vault was skipped entirely and
  its notes were simply invisible — with nothing in the output to explain why.
  Links are now followed, with a visited-realpath set so a link pointing at an
  ancestor terminates instead of walking an infinite tree. Dangling links are
  skipped rather than fatal; `followSymlinks: false` restores the old
  behaviour.

## 0.3.3 — 2026-08-07

Context economy on the MCP surface, plus a presentation fix.

Agent tool responses are the product's main interface, and every token spent
on score internals is a token not spent on the user's actual task. Measured
against a real 40-note vault:

| tool | before | after |
|---|---|---|
| `lore_search` | ~1,290 tokens | **~735** |
| `lore_context_pack` | ~1,470 tokens | **~1,000** |
| `lore_dream_report` | ~2,640 tokens | **~580** |

- **Search returns what an agent acts on** — the note, the section, the text,
  and how much of the query it matched — instead of five floats at seventeen
  significant digits. `verbose: true` restores the full shape.
- **The dream report returns a summary** with the few findings worth acting
  on; `verbose: true` returns every finding.
- **Horizontal rules no longer leak into snippets.** The markup filter ran
  when choosing and extending, but not at render, so a `---` between the
  chosen window and its context still reached the output.

## 0.3.2 — 2026-08-07

Presentation fixes, all found by running the tool on real documents. Each is a
case where retrieval was already correct and the output made it look wrong —
a class of defect recall metrics score as a success.

- **Snippets find answers split across wrapped lines.** Markdown is almost
  always hard-wrapped, so the sentence answering a query is routinely split in
  two. Scoring lines individually let each half count one term and lose to an
  unrelated earlier line, so a query about the index being a cache showed the
  README's HTML header instead of the sentence saying exactly that. Snippets
  now score windows of consecutive lines.
- **Markup is no longer presented as content.** Tag-only lines are skipped when
  choosing and extending a snippet, and tags are stripped from the rendered
  text: `<h1 align="center">Loreweave</h1>` reads as "Loreweave". The indexed
  text is untouched.
- **Result lines stay readable.** The location line printed the full heading
  breadcrumb, which reached 327 characters on a deeply nested note and buried
  the snippet. It now shows the file and innermost heading; `--json` still
  carries the exact anchor.
- **Link suggestions no longer reward length.** Raw IDF-sum meant two sprawling
  documents about one project always looked related. Scores are normalized by
  note size, so the question is whether two notes share more than their length
  predicts.

## 0.3.1 — 2026-08-07

Fixes found by dogfooding a real documentation corpus.

- **Notes whose filename states a role no longer collapse into one entity.**
  39 separate `SKILL.md` files all resolved to the title "SKILL", so their
  frontmatter facts landed in a single subject and superseded each other
  arbitrarily. A title now prefers frontmatter `title`, then `name`, then the
  filename — except for generic names (`SKILL.md`, `README.md`, `index.md`),
  where the parent folder identifies the note: `skills/writing-skills/SKILL.md`
  is "writing-skills". Measured on that corpus: 1 collapsed subject became 14
  correctly attributed ones.
- **Facts whose object merely repeats their subject are dropped.**
  `writing-skills :: name :: writing-skills` states nothing, and was appearing
  at the top of `lore ask` output.

## 0.3.0 — 2026-08-06

Retrieval, provenance, and durability. Every number below is produced by
`npm run eval` and enforced in CI.

### Retrieval

- **Markdown links are first-class graph edges.** Vaults outside Obsidian use
  `[text](path.md)`, which the engine could not see. On a real vault this took
  links from 1 to 15 and orphans from 39 to 25.
- **Link expansion finds what lexical search cannot reach.** Multi-hop answers
  share no vocabulary with the query; BM25 finds 0% of them at any depth, while
  hybrid now finds 90% (kestrel) and 100% (northwind).
- **Recall mechanisms backfill instead of competing.** Both link expansion and
  entity-PPR displaced confident lexical hits when treated as peer ranking
  lists — measured 0.489 → 0.208 MRR in the worst case. As backfill they add
  reach without costing precision.
- **Natural-language questions work.** Function words were treated as content,
  so AND semantics let one stray "what" exclude the answering block. MRR
  0.495 → 0.538.
- **Snippets show the line that answers the query**, not wherever FTS5 pointed
  — a correct result that displays the wrong excerpt reads as a miss.
- **Content time, not file time.** `--since`/`--until` filter on frontmatter
  dates, dated filenames, and dates in the text; mtime is only the fallback.

Measured against two independent corpora (the second built specifically to
detect overfitting — different link syntax, note shapes, and vocabulary):

| corpus | hybrid reach | BM25 reach | hybrid MRR | BM25 MRR |
|---|---|---|---|---|
| kestrel | 98% | 75% | 0.540 | 0.532 |
| northwind | 96% | 63% | 0.643 | 0.521 |

### Facts

- **Facts are extracted from the conventions vaults already use** —
  frontmatter, `key:: value`, `- [key] value`. The store measured 0 facts on
  every real vault before this. Prose formatting is opt-in
  (`facts.extract: "all"`) or reviewable via the `lore_propose_facts` MCP tool.
- **Provenance is visible.** Every fact prints where it came from and whether
  it was asserted, extracted, or inferred, so a supersession chain reads as an
  audit trail.
- Fixed: `::` in a subject corrupted facts permanently; frontmatter dates were
  silently dropped; task-list items (`- [x] …`) were parsed as facts.

### Durability

- A corrupt index resets itself rather than bricking every command.
- Concurrent commands no longer fail with "database is locked".
- A crash mid-index is detected by PID and repaired on the next run.
- `dream` survives real vaults: 3,200 notes went from 69.6s/3.56GB to
  1.11s/190MB, and 12,800 notes (double the previous OOM point) now works.
- Unbounded inputs are capped — a 1MB single-paragraph note took search from
  30.05s to 0.16s.

### New

- `lore watch` — reindex automatically as the vault changes.
- `npm run eval` — the retrieval benchmark, as a CI gate over both corpora.
- `npm run smoke` — verifies the packed tarball, not just the source.

## 0.2.0 — 2026-08-06

First public release with the full engine: hybrid retrieval, bitemporal facts,
FSRS dynamics, the dream consolidation pass, CLI, and MCP server.

## 0.1.0 — 2026-08-05

Initial release.
