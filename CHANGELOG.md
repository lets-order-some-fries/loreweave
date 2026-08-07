# Changelog

## 0.5.5 — 2026-08-07

Verified the spaced-repetition layer end to end rather than inferring it from
the FSRS unit tests. Nothing needed fixing; the properties are now asserted.

- **Reinforcement changes what search returns.** With five notes that answer a
  query equally well, marking the last one used moves it to first.
- **Usage history survives a reindex.** It is the only thing in the index that
  cannot be re-derived from the vault, and the index is rebuilt from markdown
  constantly — had a reindex wiped it, the layer would reset every time a file
  was saved and every existing test would still have passed, because they
  exercise the maths in isolation.
- **An edit resets only what it changed.** Rewriting one section of a note
  preserves the history of the sections that did not change and resets that
  one, which is correct: a retrieval history describes text, and that block's
  text no longer exists.

## 0.5.4 — 2026-08-07

- **A mistyped config key is named instead of ignored.** Zod strips unknown
  keys rather than rejecting them, so a wrong key was accepted in silence and
  had no effect: `{"nlpp": false}` left NLP running, and
  `{"index": {"nlp": false}}` — a natural guess, since `nlp` lives at the top
  level — was discarded whole. Config is the worst place for a silent no-op:
  every other surface at least does something you can observe, while editing
  config and re-running produces identical output whether the edit took effect
  or not. Reported as a warning, not an error, so a config written for a newer
  version does not brick an older one.
- **`lore init`'s own config is checked against the schema.** That file is the
  first config most users see; if it drifted it would configure nothing, and
  nothing would say so.

The set of known keys is derived from a fully-defaulted parse rather than from
the schema's internals, so it stays correct on its own as the schema grows.

## 0.5.3 — 2026-08-07

Killed the indexer mid-run on a 1 200-note vault, with SIGTERM and then
SIGKILL. Recovery is already sound — the next index notices the previous one
did not finish, rebuilds, and search comes back correct, with database
integrity ok after a hard kill. The reporting was not.

- **`doctor` no longer reports a healthy vault as broken.** On a half-built
  index it said `broken links: 1091` for a vault whose links are all fine — the
  notes they point at simply had not been indexed yet. Specific, alarming and
  confidently inverted, at the exact moment a user is already worried because
  they just interrupted something.
- **The indexer already knew.** It keeps a marker naming the indexing PID and
  distinguishes a crashed run from a live one, but only the indexer read it.
  That state is exported now, and both commands that read the index as though
  it described the vault — `doctor` and `stats` — say so first.

Tested three ways: an interrupted index is recognised, a live one is not
mistaken for a dead one, and recovery reproduces exactly the blocks and links a
clean index would have produced — "it rebuilds" only reassures if what it
rebuilds is right.

## 0.5.2 — 2026-08-07

Yesterday's migration was nearly wrong in a way that only appears on an
upgrade, never on a fresh install — so the upgrade path got checked properly
rather than the one hop that happened to get tested.

- **Verified against real installs.** 0.1.0, 0.2.0, 0.3.0, 0.3.5 and 0.4.0 were
  installed from npm, each indexed a vault, and the current build then opened
  the same database. All five upgrade cleanly — schema v1, v3 and v4 all reach
  v5, reparse, and still answer searches. Nothing was broken; that is worth
  knowing rather than assuming, because a failed migration does not degrade the
  tool, it stops it starting.
- **Reproduced in the suite without the network.** Each historical schema is
  now built from the migration list itself, so every future migration is
  checked against every old database automatically, rather than against
  whichever version someone remembers to install.
- **The specific mistake is pinned.** Incremental indexing short-circuits on
  mtime *and* size before it consults the hash, so a migration that clears only
  the hash changes nothing. The test fails if that invalidation is weakened.

## 0.5.1 — 2026-08-07

Checked the temporal query path against a vault where every mtime was touched
to now, so file times carried no information at all. Content time held up:
`--since`/`--until` filter on dates from the filename, the frontmatter and the
prose; frontmatter wins when a filename and frontmatter date disagree; mtime is
used only where the content carries no date of its own. `doctor` finds every
broken link and all three graph export formats are well formed.

- **`doctor` quotes each broken link the way the file spells it.** It printed
  `alpha.md → [[sub/nope.md]]` for a line that reads
  `[a broken one](sub/nope.md)`. The parser has always distinguished wiki from
  markdown links and the store discarded it, so the report guessed wiki for
  everything — sending the reader grepping for text that is not in their vault,
  in the one report whose purpose is "go fix this line". Link style is now
  persisted (schema v5).
- **The migration invalidates what the old parser recorded.** Adding the column
  was not enough: incremental indexing short-circuits on mtime *and* size
  before it ever consults the hash, so clearing the hash alone changed nothing
  and every upgraded vault would have kept the column default forever. All
  three keys are cleared, so the next index reparses.

## 0.5.0 — 2026-08-07

Built a vault of the shape someone would actually keep — dated daily notes, a
project whose status and owner change over time — and read what the fact store
made of it. The bitemporal core is sound: the canonical
`- [fact] S :: p :: o {valid_from=…}` round-trips exactly. Three things around
it did not.

- **Frontmatter dates keep the date that was written.** `started: 2025-03-01`
  came back as the object `2025-03-01T00:00:00.000Z` — YAML parses a bare date
  into a Date, and frontmatter is stored as JSON, so every reader saw an
  instant with a timezone nobody typed. A guard for exactly this existed in the
  extractor and was dead: it tested `instanceof Date` on a value JSON had
  already turned into a string. Frontmatter is normalised at parse time now; a
  value with a real time of day keeps it.
- **Trailing `{valid_from=…}` is honoured on every fact form.** It is this
  project's own syntax — the journal emits it on every line it writes — but
  only `- [fact]` read it back. Elsewhere the braces were swallowed into the
  object, so the date was lost *and* it corrupted the value. A `{...}` that is
  not `key=value` is left alone.
- **Dataview fields are read on a bare line, not only inside a list.** Obsidian
  users write `key:: value` on its own line at least as often, so half of a
  supported convention was silently ignored. The space after `::` is what makes
  this safe — `std::vector`, `Foo::bar` and every scope operator in every
  language have none — and fenced blocks are skipped regardless.

## 0.4.10 — 2026-08-07

0.4.9 removed heading echoes from duplicate detection. Rather than wait to trip
over the same object again, every consumer of block text was checked against
it — and embeddings had the same bug, worse.

- **Heading echoes are no longer embedded.** Identical text yields an identical
  vector under any model, so two notes sharing a section name — "Overview",
  "Usage", "The Process" — scored a cosine of exactly 1.0 and got a
  maximum-strength `SIMILAR` edge between them. That edge feeds graph
  expansion, so what showed up as a wrong line in a report was also silently
  steering retrieval, where nothing would have surfaced it. They also cost real
  embedding calls on text nobody wrote: 40 of 501 blocks on the test vault.
- **One shared definition.** `isHeadingEcho` is now exported and used by both
  `dream` and the embedder. Two copies would drift, and both failures it
  prevents are silent.

Nothing is lost: an echo exists so a headings-only note stays findable, and its
heading is already in the lexical index. The test asserts both directions — no
similarity edge from a shared section name, and both notes still returned when
searching for that heading.

## 0.4.9 — 2026-08-07

Ran `dream` over a real docs vault and read what it found. Link suggestions are
real — `code-reviewer.md` and `task-reviewer-prompt.md` share eighteen
entities. The duplicates were not.

- **Two sections with the same name are no longer "duplicates".** Top of the
  list was `"The Process" ≈ "The Process"` at Jaccard 1.0 for two unrelated
  skills. Since 0.4.1 a section with no body of its own is indexed as an echo
  of its heading, so a headings-only note stays findable — but section names
  repeat constantly, so comparing those echoes as content made every shared
  section name an identical passage. 40 of 501 blocks in that vault were
  echoes, and they produced most of the duplicate findings. The echo stays
  indexed and searchable; it is excluded from duplicate detection only.
  Genuinely copy-pasted prose is still caught, and both halves are now tested.
- **Every finding type shows examples.** `dream` reported "6 duplicates · 23
  orphans" and then listed only link suggestions; the rest were visible only by
  running `--apply`, which writes files into the vault — so looking required
  changing. Duplicates, stale items and orphans now each show a few, with a
  count of how many more.

## 0.4.8 — 2026-08-07

Read `ask` output on a real docs vault and followed one odd line: the answer to
"when should I use a worktree" included a note about persuasion technique,
reached "via use".

- **A shouted word is emphasis, not an acronym.** `use` was an entity because
  of "YOU MUST USE IT" — the acronym exemption fired on any all-caps token,
  and that exemption exists precisely to rescue `NASA` and `API` *from* the
  common-word filter, so unconditionally it resurrected the very words the
  filter removes. Documentation shouts constantly, so this was a standing
  mis-read of emphasis as vocabulary. `NASA` and `API` are unaffected.
- **A contraction is not a person.** "I'm" tokenises to a capitalised `Im` and
  tags PROPN, making it an entity in 9 of 39 notes in a vault whose every skill
  opens by announcing itself. `O'Brien` and `D'Angelo` are untouched.
- **Seed mass is scaled by inverse document frequency.** An entity mentioned
  across a quarter of the vault is background, not a topic; spreading
  activation from it reaches a quarter of the vault, which is the same as
  reaching nothing. This is the general form of a stopword list, and unlike one
  it needs no maintenance and adapts to whatever the vault is about.

IDF alone would not have fixed `use` — it appears in two notes, so it is rare,
just meaningless. Rare-and-meaningless needs the extractor;
common-and-meaningless needs the weighting.

Top entities on that vault are now TDD, Task, Review, API, Subagents, Gemini
CLI, Copilot CLI, YAGNI. Both eval corpora unchanged.

## 0.4.7 — 2026-08-07

Verified against the published package: the MCP wiring the README documents
works end to end over real stdio, and so does an MCP server running live under
an agent while the user works in a terminal — the CLI indexes, the server sees
the new note immediately, both write facts at once, nothing is lost.

- **A mistyped `--vault` says so.** It reported
  `ENOENT: no such file or directory, mkdir '/nope/.lore'` — a raw errno naming
  an internal directory the user has never heard of, for a mistake in the one
  argument they can see. Now: `vault not found: /nope`, and
  `vault is not a directory` when the path is a file.
- **Auto-indexing is opt-in** (regression from 0.4.6, where it was opt-out). It
  fired for commands that never read the note index, so a mistyped date spent a
  full pass over the vault before reporting the typo. It is now held to the
  commands that answer questions about note content — `search`, `ask`, `dream`,
  `graph`, `mark-used`.

## 0.4.6 — 2026-08-07

Installed the published package into a clean directory and used it as a new
user would. The first command typed said the wrong thing.

- **A never-indexed vault no longer answers "no results".** `lore search` in a
  vault of 39 notes replied `no results`; `ask` replied `nothing found`. That
  is indistinguishable from a genuine miss, delivered at the one moment a new
  user cannot tell the difference — it says the tool works and their notes are
  empty. Only `doctor` told the truth. An empty index is now filled on the
  spot, once, by any command that answers questions about the vault.
- **Agents were affected worse than people.** Over MCP there was no error to
  react to — just `[]`, which an agent reports as "you have nothing written on
  this". The server now indexes before serving its first request.
- **The commands that report on the index itself opt out.** `index`, `doctor`
  and `stats` still show the true state, including that it is empty — as does a
  genuinely empty vault, where "no results" is the correct answer.

## 0.4.5 — 2026-08-07

Indexed a real 86-note documentation vault instead of a synthetic one. The
ranking held up — every probe query returned the right note *and* the right
section — but what got *shown* did not.

- **A generated diagram no longer masquerades as the answer.** Asking "what
  should I do when a test fails" returned the correct heading of a TDD guide
  and then displayed 800 characters of `digraph tdd_cycle { … }`. Generated
  source restates the vocabulary of the prose it illustrates, so it ties on
  term coverage — and ties went to whichever block came first, which is the
  diagram. It now has to out-cover the readable alternative outright, and the
  same query returns *"MANDATORY. Never skip. … Confirm: Test fails (not
  errors), failure message is expected"*.
- **Previews lead with prose.** A snippet that runs from prose into its example
  reads well; the same two pieces in the other order bury the answer behind
  source the reader has to scroll past. Context now grows forward into code but
  never backward into it.
- **Bare fence markers are gone from previews** — a snippet no longer spends
  its first characters rendering ``` for a renderer that is not running.

Across 36 real hits, previews opening with raw source went from 6-in-30 to
1-in-36 — and the survivor is a query about the diagram itself.

## 0.4.4 — 2026-08-07

- **`watch` now reindexes a vault that never goes quiet.** The debounce
  restarted its timer on every change, so as long as changes kept arriving no
  reindex ever ran — and the things that keep a vault busy are exactly the ones
  that matter: a sync client landing another device's notes, a bulk import,
  `git checkout` of a large branch, an agent capturing as it works. Measured:
  six seconds of writes 120 ms apart produced **zero** reindexes, so every
  search in that window answered from a stale index with nothing to say so.
  A reindex is now deferred at most `maxWaitMs` (default 2 s), while a single
  edit still waits out the full quiet period.
- **`watch` has tests at all now,** including the three ways real editors save:
  in place (Obsidian), temp-file-and-rename (VSCode, Emacs), and
  backup-then-write (vim). All three already worked; nothing was checking.
- **Incremental indexing is asserted equal to a rebuild.** After each of nine
  vault mutations — edit, delete, rename, move, add, truncate, drop a folder,
  swap two notes, replace everything — the incrementally-updated database must
  match a from-scratch index of the same bytes, down to blocks, links,
  entities, mentions and FTS rows. The index is meant to be disposable; this is
  what makes that claim checkable.

## 0.4.3 — 2026-08-07

- **A pasted blob no longer holds a vault hostage.** Indexing a note containing
  one very long unbroken token — an Excalidraw drawing, a base64 `data:` image,
  a minified bundle, a JWT — took time *quadratic* in that token's length,
  because the POS tagger is. A 2 MB blob took roughly half an hour for that one
  note; it now takes 38 ms. A 3 000-note, 19 MB vault that previously did not
  finish indexing in ten minutes now indexes in 4 seconds.
- **Blocks are capped in characters, not only in words.** The existing word cap
  was measured in the wrong unit for the exact case it was written for: a blob
  is ONE word, so `words <= 350` passed and the block stayed unbounded. Blocks
  are now also capped at 4 000 characters, which additionally bounds CJK
  paragraphs — they contain no whitespace either.
- **Splitting never severs a surrogate pair,** so emoji and astral-plane text
  cannot be corrupted on the way into the database.
- Tokens of 64 characters or more are no longer fed to the entity tagger. No
  proper noun is that long; the things that are — hashes, payloads, data URIs —
  were only ever noise in the graph.

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
