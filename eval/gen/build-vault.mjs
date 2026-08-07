/** Render the Kestrel Basin vault to disk from the domain model. */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  people, stations, instruments, datasets, projects, expeditions, methods, papers, orgs, forbidden,
} from './domain.mjs';

/**
 * Render the Kestrel Basin eval vault to `outDir`. Deterministic: the same
 * input model always produces byte-identical files, so eval runs are
 * comparable across commits.
 */
export function buildVault(outDir, { quiet = true } = {}) {
const OUT = outDir;

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });

const written = [];
function write(rel, body) {
  const abs = join(OUT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
  written.push(rel);
}

const list = (xs) => xs.map((x) => `[[${x}]]`).join(', ');
const fm = (type, tags) => `---\ntype: ${type}\ntags: [${tags.join(', ')}]\n---\n\n`;

/**
 * Shared filler prose. Deliberately avoids every token reserved for the
 * multi-hop isolation tests, so it can be sprinkled anywhere. Its job is to
 * give the lexical index realistic competition: common domain words that
 * appear in dozens of notes and therefore carry little discriminative weight.
 */
const POOL = [
  'The basin runs roughly north to south, and almost every observation the programme makes is referred back to the same drainage divide.',
  'Season length is short. Most work happens between the middle of June and the first hard freeze, which in a bad year arrives in the third week of August.',
  'Access is by fixed-wing aircraft to the lower strip and on foot from there; nothing heavier than sixty kilograms moves without a sortie being planned a season ahead.',
  'Weather closes the valley without much warning, and the standing rule is that nobody moves between sites on a forecast of more than thirty knots.',
  'Power comes from a small diesel set backed by a solar bank, which is enough for the sensors but not for anything that heats.',
  'Radio is line of sight to the repeater on the western rim; when the repeater ices up the sites fall back to a scheduled satellite window each evening.',
  'All raw material is written twice on arrival, once to the local disk and once to the pooled store, before anybody touches it.',
  'Quality flags follow the shared four-level scheme: good, suspect, provisional, and withdrawn. Nothing is ever deleted, only reflagged.',
  'Metadata is checked against the shared site codes each spring, which is tedious but has caught three mislabelled seasons so far.',
  'The programme publishes an annual reconciliation of everything it holds, which is the only document that anybody outside reads in full.',
  'Funding is reviewed on a four-year cycle and renewal has never yet been refused, though the 2018 review came close.',
  'Field notebooks are scanned at the end of each season and the scans are treated as the record of last resort when a timestamp is disputed.',
  'Snowpack over the sensors is measured by hand on the first of every month through the winter, because no automatic method has yet survived a full season.',
  'The valley floor thaws about three weeks earlier than it did when the oldest site opened, which shows up in almost every long record the programme keeps.',
  'Spare parts are held at two sites rather than one, a policy adopted after a single lost pallet cost most of a season.',
  'Anything carried above two thousand metres has to run unattended for at least nine months, which rules out most off-the-shelf designs.',
  'Calibration references travel with a courier each spring and are returned to the national laboratory in the autumn for recertification.',
  'The shared processing toolchain is pinned to a single release for the whole season so that reprocessing is reproducible after the fact.',
  'Time is kept against GPS where a receiver is available and against a disciplined oscillator where it is not; drift between the two is logged.',
  'Anyone spending more than two nights above the treeline carries a beacon, and the beacon check is the first item on every departure list.',
  'Sample material is handled cold from collection to the store, and the chain of custody is written on the container rather than in a separate book.',
  'The 2021 rime event is the reference bad season against which every design decision since has been argued.',
  'Visitors are rare and are always paired with a member of the roster, which is as much about not losing them as about the science.',
  'The oldest continuous record in the basin starts in 2004 and has three gaps, none longer than eleven days.',
];

let poolCursor = 0;
function filler(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(POOL[poolCursor++ % POOL.length]);
  return out.join(' ');
}

// ── people ────────────────────────────────────────────────────────────────
for (const p of people) {
  let b = fm('person', ['kestrel', 'roster']);
  b += `${p.name} is a ${p.role} with the Kestrel Basin Hydrology Programme, on the roster since ${p.joined}.\n\n`;
  b += `## Posting\n\nBased at [[${p.station}]].\n\n`;
  const workBits = [];
  if (p.leads.length) workBits.push(`Leads ${list(p.leads)}.`);
  if (p.devised.length) workBits.push(`Devised the ${list(p.devised)}.`);
  if (p.curates.length) workBits.push(`Keeps the ${list(p.curates)} in order.`);
  if (p.built.length) workBits.push(`Built the ${list(p.built)}.`);
  if (workBits.length) b += `## Work\n\n${workBits.join(' ')}\n\n`;
  const auth = papers.filter((x) => x.authors.includes(p.name));
  if (auth.length) b += `## Writing\n\n${auth.map((x) => `[[${x.title}]] (${x.year})`).join('; ')}.\n\n`;
  b += `## Background\n\n${p.history}\n\n`;
  b += `## Working notes\n\n${filler(3)}\n`;
  write(`people/${p.name}.md`, b);
}

// ── stations ──────────────────────────────────────────────────────────────
for (const s of stations) {
  let b = fm('station', ['kestrel', 'sites']);
  b += `${s.name} is a field site of the Kestrel Basin Hydrology Programme, sitting on ${s.place}. It was established in ${s.est}.\n\n`;
  b += `## Site data\n\nElevation ${s.elev} m. Bunk capacity ${s.bunks}. Site lead: [[${s.lead}]].\n\n`;
  b += `## Standing equipment\n\n${s.name} carries the ${list(s.hosts)}.\n\n`;
  b += `## Site history\n\n${s.history}\n\n`;
  b += `## Living and working here\n\n${filler(4)}\n`;
  write(`stations/${s.name}.md`, b);
}

// ── instruments ───────────────────────────────────────────────────────────
for (const i of instruments) {
  let b = fm('instrument', ['kestrel', 'kit']);
  b += `The ${i.name} measures ${i.measures}. It is one of the standing units of the Kestrel Basin Hydrology Programme.\n\n`;
  b += `## Specification\n\nSerial ${i.serial}. Sampling cadence ${i.cadence}. Power draw ${i.power}. Commissioned ${i.commissioned}.\n\n`;
  const siting = [`The ${i.name} stands at [[${i.station}]].`];
  if (i.builder) siting.push(`It was built by [[${i.builder}]].`);
  siting.push(`Its readings are checked against the [[${i.calibration}]].`);
  b += `## Siting and upkeep\n\n${siting.join(' ')}\n\n`;
  if (i.feeds.length) b += `## Output\n\nThe ${i.name} feeds the ${list(i.feeds)}.\n\n`;
  b += `## Service record\n\n${i.history}\n\n`;
  b += `## Operating notes\n\n${filler(3)}\n`;
  write(`instruments/${i.name}.md`, b);
}

// ── datasets ──────────────────────────────────────────────────────────────
for (const d of datasets) {
  let b = fm('dataset', ['kestrel', 'data']);
  b += `The ${d.name} holds ${d.holds}. It is one of the ten holdings tracked by the Kestrel Basin data management plan.\n\n`;
  b += `## Shape\n\n${d.records.toLocaleString('en-US')} records covering ${d.span}. Stored as ${d.format}, ${d.size} on disk.\n\n`;
  const prov = [];
  if (d.instrument) prov.push(`Everything in the ${d.name} comes off the [[${d.instrument}]].`);
  prov.push(`It is produced under [[${d.project}]] and kept by [[${d.curator}]].`);
  b += `## Provenance\n\n${prov.join(' ')}\n\n`;
  if (d.papers.length) b += `## Cited by\n\n${d.papers.map((x) => `[[${x}]]`).join('; ')}.\n\n`;
  b += `## Curation notes\n\n${d.history}\n\n`;
  b += `## Handling\n\n${filler(3)}\n`;
  write(`datasets/${d.name}.md`, b);
}

// ── projects ──────────────────────────────────────────────────────────────
for (const p of projects) {
  let b = fm('project', ['kestrel', 'work']);
  b += `${p.name} is a strand of the Kestrel Basin Hydrology Programme that sets out to ${p.aim}. It began in ${p.started}.\n\n`;
  b += `## Standing\n\nLed by [[${p.lead}]]. Funded by [[${p.funder}]]. Award value ${p.budget}.\n\n`;
  if (p.station) b += `## Base\n\nField work for ${p.name} runs out of [[${p.station}]].\n\n`;
  if (p.expeditions.length) {
    b += `## Field seasons\n\n${p.name} has put ${p.expeditions.length} traverse${p.expeditions.length > 1 ? 's' : ''} into the field: ${list(p.expeditions)}.\n\n`;
  }
  if (p.methods.length) b += `## Practice\n\nWork follows the ${list(p.methods)}.\n\n`;
  b += `## Timeline\n\n${p.history}\n\n`;
  b += `## Operating context\n\n${filler(3)}\n`;
  write(`projects/${p.name}.md`, b);
}

// ── expeditions ───────────────────────────────────────────────────────────
for (const e of expeditions) {
  let b = fm('expedition', ['kestrel', 'field']);
  b += `The ${e.name} was a field traverse run in ${e.year} under [[${e.project}]]. ${e.note}\n\n`;
  b += `## Logistics\n\nDates ${e.dates}. Distance covered ${e.km} km. Party of ${e.party}.\n\n`;
  b += `## Kit carried\n\nThe ${e.name} deployed the ${list(e.instruments)}.\n\n`;
  b += `## Party\n\n${list(e.people)}.\n\n`;
  b += `## Conditions\n\n${filler(3)}\n`;
  write(`expeditions/${e.name}.md`, b);
}

// ── methods ───────────────────────────────────────────────────────────────
for (const m of methods) {
  let b = fm('method', ['kestrel', 'practice']);
  b += `The ${m.name} is ${m.what}. It was written up by [[${m.by}]] in ${m.year}.\n\n`;
  if (m.appliedTo.length) b += `## Applied to\n\nThe ${m.name} is applied to the ${list(m.appliedTo)}.\n\n`;
  if (m.usedBy.length) b += `## In use by\n\n${list(m.usedBy)}.\n\n`;
  b += `## Rationale\n\n${filler(3)}\n`;
  write(`methods/${m.name}.md`, b);
}

// ── papers ────────────────────────────────────────────────────────────────
for (const p of papers) {
  let b = fm('paper', ['kestrel', 'writing']);
  b += `"${p.title}" appeared in ${p.journal} in ${p.year}, ${p.pages} pages.\n\n`;
  b += `## Authors\n\n${list(p.authors)}.\n\n`;
  if (p.datasets.length) b += `## Data used\n\n${list(p.datasets)}.\n\n`;
  if (p.methods.length) b += `## Practice\n\n${list(p.methods)}.\n\n`;
  b += `## Context\n\n${filler(2)}\n`;
  write(`papers/${p.title}.md`, b);
}

// ── orgs ──────────────────────────────────────────────────────────────────
for (const o of orgs) {
  let b = fm('funder', ['kestrel', 'money']);
  b += `The ${o.name} is ${o.kind}. It has supported Kestrel Basin work since ${o.since}.\n\n`;
  b += `## Awards held\n\nThe ${o.name} currently supports ${o.funds.length} strand${o.funds.length > 1 ? 's' : ''}: ${list(o.funds)}.\n\n`;
  b += `## Terms\n\n${filler(2)}\n`;
  write(`orgs/${o.name}.md`, b);
}

// ── meta notes ────────────────────────────────────────────────────────────
write('meta/Programme Overview.md',
  fm('meta', ['kestrel']) +
  `The Kestrel Basin Hydrology Programme is a long-running observation effort across the Kestrel drainage. ` +
  `It operates ${stations.length} field stations, runs ${projects.length} funded strands, and keeps ${datasets.length} holdings.\n\n` +
  `## Field stations\n\nThe programme operates ${stations.length} field stations: ${list(stations.map((s) => s.name))}.\n\n` +
  `## Funders\n\n${orgs.length} bodies support the work: ${list(orgs.map((o) => o.name))}.\n\n` +
  `## Reading\n\nStart with the [[Personnel Roster]], the [[Station Directory]], the [[Data Management Plan]], the [[Methods Handbook]] and the [[Expedition Log]].\n`);

write('meta/Personnel Roster.md',
  fm('meta', ['kestrel', 'roster']) +
  `The Kestrel Basin roster stands at ${people.length} researchers.\n\n` +
  `## Roster\n\n` + people.map((p) => `- [[${p.name}]] — ${p.role}, [[${p.station}]]`).join('\n') + '\n');

write('meta/Station Directory.md',
  fm('meta', ['kestrel', 'sites']) +
  `Every field site of the programme, oldest first.\n\n## Directory\n\n` +
  [...stations].sort((a, b) => a.est - b.est).map((s) => `- [[${s.name}]] — established ${s.est}, ${s.elev} m, ${s.bunks} bunks, site lead [[${s.lead}]]`).join('\n') + '\n');

write('meta/Data Management Plan.md',
  fm('meta', ['kestrel', 'data']) +
  `The plan tracks ${datasets.length} holdings across the programme. Each has a named keeper and a stated retention.\n\n` +
  `## Tracked holdings\n\n` + datasets.map((d) => `- [[${d.name}]] — kept by [[${d.curator}]], ${d.format}, ${d.size}`).join('\n') + '\n');

write('meta/Methods Handbook.md',
  fm('meta', ['kestrel', 'practice']) +
  `The handbook lists ${methods.length} written-up practices in use across the programme.\n\n` +
  `## Practices\n\n` + methods.map((m) => `- [[${m.name}]] — ${m.by}, ${m.year}`).join('\n') + '\n');

const byYear = {};
for (const e of expeditions) (byYear[e.year] ??= []).push(e.name);
write('meta/Expedition Log.md',
  fm('meta', ['kestrel', 'field']) +
  `Every traverse the programme has put into the field, ${expeditions.length} in total.\n\n` +
  `## By season\n\n` +
  Object.keys(byYear).sort().map((y) => `- ${y}: ${byYear[y].length} traverse${byYear[y].length > 1 ? 's' : ''} — ${byYear[y].map((n) => `[[${n}]]`).join(', ')}`).join('\n') + '\n');

write('meta/Publication List.md',
  fm('meta', ['kestrel', 'writing']) +
  `${papers.length} papers have come out of the programme.\n\n## Papers\n\n` +
  [...papers].sort((a, b) => a.year - b.year).map((p) => `- [[${p.title}]] — ${p.journal}, ${p.year}`).join('\n') + '\n');

// ── journal notes carrying bitemporal facts ───────────────────────────────
const journal = {
  '2016-04-01': [
    '- [fact] Ridgeholt Station :: site_lead :: Tomas Belka {valid_from=2016-04-01, confidence=1.0, source=stated}',
  ],
  '2017-03-14': [
    '- [fact] Halcyon-3 Interferometer :: hosted_at :: Umber Flats {valid_from=2017-03-14, confidence=1.0, source=stated}',
  ],
  '2018-01-15': [
    '- [fact] Kelpline Register :: title :: Basin Water Ledger {valid_from=2018-01-15, confidence=1.0, source=stated}',
    '- [fact] Project Windrow :: scope :: single catchment {valid_from=2013-04-01, confidence=0.9, source=stated}',
  ],
  '2019-03-04': [
    '- [fact] Nadia Okonjo :: based_at :: Norwynd Hut {valid_from=2014-02-01, confidence=1.0, source=stated}',
    '- [fact] Nadia Okonjo :: based_at :: Calder Point {valid_from=2019-03-01, confidence=1.0, source=stated}',
    '- [fact] Project Quillfall :: status :: planning {valid_from=2019-01-01, confidence=1.0, source=stated}',
    '- [fact] Project Windrow :: scope :: whole basin {valid_from=2018-06-01, confidence=0.9, source=stated}',
    '- [fact] Coldspar Traverse :: run_under :: Project Quillfall {valid_from=2019-07-08, confidence=1.0, source=stated}',
  ],
  '2020-07-20': [
    '- [fact] Deepwell Traverse :: run_under :: Project Marrowbone {valid_from=2020-06-19, confidence=1.0, source=stated}',
    '- [fact] Project Thornfield :: funder :: Hollis Trust {valid_from=2016-01-01, confidence=1.0, source=stated}',
    '- [fact] Project Thornfield :: funder :: Merridew Council {valid_from=2020-04-01, confidence=1.0, source=stated}',
  ],
  '2021-09-28': [
    '- [fact] Halcyon-3 Interferometer :: hosted_at :: Ridgeholt Station {valid_from=2021-09-01, confidence=1.0, source=stated}',
    '- [fact] Emberline Traverse :: run_under :: Project Sablefin {valid_from=2021-08-01, confidence=1.0, source=stated}',
    '- [fact] Farrowgate Traverse :: run_under :: Project Ostinato {valid_from=2021-09-03, confidence=1.0, source=stated}',
    '- [fact] Cormorant Set :: keeper :: Elias Marchetti {valid_from=2019-06-11, confidence=1.0, source=stated}',
    '- [fact] Cormorant Set :: keeper :: Oskar Freundlich {valid_from=2021-05-01, confidence=1.0, source=stated}',
    '- [fact] Tessellate Bay :: depot :: Harrowgate Landing {valid_from=2018-03-01, confidence=1.0, source=stated}',
    '- [fact] Tessellate Bay :: depot :: Tessellate Pier {valid_from=2021-06-01, confidence=1.0, source=stated}',
  ],
  '2022-08-30': [
    '- [fact] Project Quillfall :: status :: fieldwork {valid_from=2022-03-01, confidence=1.0, source=stated}',
    '- [fact] Gullwing Traverse :: run_under :: Project Quillfall {valid_from=2022-07-02, confidence=1.0, source=stated}',
    '- [fact] Hesperus Traverse :: run_under :: Project Marrowbone {valid_from=2022-06-11, confidence=1.0, source=stated}',
    '- [fact] Project Ostinato :: picker :: fixed STA/LTA rule {valid_from=2013-08-01, confidence=1.0, source=stated}',
    '- [fact] Project Ostinato :: picker :: Cindergrain Filter {valid_from=2022-05-01, confidence=1.0, source=stated}',
    '- [fact] Vellum Sonde :: cadence :: 24 hours {valid_from=2018-09-30, confidence=1.0, source=stated}',
  ],
  '2023-06-30': [
    '- [fact] Ridgeholt Station :: site_lead :: Ingrid Halvorsen {valid_from=2023-06-01, confidence=1.0, source=stated}',
    '- [fact] Kelpline Register :: title :: Kelpline Register {valid_from=2023-03-01, confidence=1.0, source=stated}',
    '- [fact] Ivorybell Traverse :: run_under :: Project Marrowbone {valid_from=2023-06-24, confidence=1.0, source=stated}',
    '- [fact] Vellum Sonde :: cadence :: 12 hours {valid_from=2023-04-01, confidence=1.0, source=stated}',
    '- [fact] Project Marrowbone :: draw_rule :: fixed volume {valid_from=2016-05-20, confidence=1.0, source=stated}',
    '- [fact] Project Marrowbone :: draw_rule :: Fallowcount Calibration {valid_from=2021-06-01, confidence=1.0, source=stated}',
  ],
  '2024-07-10': [
    '- [fact] Jackdaw Traverse :: run_under :: Project Hollowmere {valid_from=2024-05-30, confidence=1.0, source=stated}',
  ],
  '2025-01-20': [
    '- [fact] Project Quillfall :: status :: analysis {valid_from=2025-01-01, confidence=1.0, source=stated}',
  ],
};
for (const [date, lines] of Object.entries(journal)) {
  write(`lore/journal/${date}.md`,
    `---\ntype: journal\ntags: [kestrel, journal]\n---\n\n## Recorded\n\n${lines.join('\n')}\n`);
}

// ── isolation assertions ──────────────────────────────────────────────────
let violations = 0;
for (const [rel, banned] of Object.entries(forbidden)) {
  const abs = join(OUT, rel);
  const text = readFileSync(abs, 'utf8');
  for (const tok of banned) {
    if (text.toLowerCase().includes(tok)) {
      console.error(`VIOLATION ${rel}: contains forbidden "${tok}"`);
      violations++;
    }
  }
}

if (!quiet) {
  console.log(`wrote ${written.length} notes to ${OUT}`);
  console.log(`isolation violations: ${violations}`);
}
if (violations > 0) {
  throw new Error(`eval vault generator produced ${violations} isolation violation(s)`);
}
return { notes: written.length, violations };
}

// CLI use: node eval/gen/build-vault.mjs [outDir]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] ?? join(dirname(new URL(import.meta.url).pathname), '..', 'vault');
  buildVault(target, { quiet: false });
}
