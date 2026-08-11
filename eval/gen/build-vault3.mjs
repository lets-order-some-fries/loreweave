/**
 * Third eval corpus: "Meridian Works" — a vault where facts CHANGE over time.
 *
 * The first two corpora measure whether retrieval finds the right note; this
 * one measures whether it finds the right TIME. Statuses flip, people move,
 * vendors are replaced — each change recorded in a journal note whose date
 * lives ONLY in frontmatter, never in the filename, heading, or body prose.
 * That is the discipline the whole corpus rests on: BM25 cannot see the
 * dates, so a question naming a window ("Cinder Vane in 2023") can only be
 * answered by temporal machinery, not by lexical accident. The flip pairs
 * are the point: the same question with a shifted window has a DIFFERENT
 * correct answer, which is exactly what TimeQA-style analyses show systems
 * fake their way through when unperturbed.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Dated change events. Bodies must never contain a year or month name. */
const JOURNAL = [
  {
    file: 'journal/cinder-vane-first-light.md', date: '2023-05-11', title: 'Cinder Vane first light',
    body: 'The [[Cinder Vane]] ran on the bench for the first time today. It is a prototype: hand-soldered boards, no enclosure, and calibration done by eye. [[Odalys Ferreira]] logged the first traces.',
  },
  {
    file: 'journal/cinder-vane-pilot-review.md', date: '2024-06-18', title: 'Cinder Vane pilot review',
    body: 'Review concluded the [[Cinder Vane]] is ready to leave the bench. Status moves from prototype to pilot, with field units installed at two customer sites. Enclosures came in from the machine shop last week.',
  },
  {
    file: 'journal/cinder-vane-retirement.md', date: '2026-02-09', title: 'Cinder Vane wind-down',
    body: 'The [[Cinder Vane]] is retired as of this entry. Remaining field units come back for parts. Its replacement, the [[Halyard Loom]], covers every deployment the pilot reached.',
  },
  {
    file: 'journal/hosting-foxglove-cutover.md', date: '2023-03-02', title: 'Hosting cutover complete',
    body: 'All Meridian infrastructure now runs at [[Foxglove Systems]]. The cutover took a weekend; the old racks are dark. Billing consolidates to a single Foxglove invoice.',
  },
  {
    file: 'journal/hosting-tern-harbor-move.md', date: '2025-08-21', title: 'Hosting moved again',
    body: 'We have left [[Foxglove Systems]]. [[Tern Harbor]] runs everything now — compute, storage, and the build fleet. Latency to the coastal sites dropped noticeably after the move.',
  },
  {
    file: 'journal/okonjo-lisbon-desk.md', date: '2022-10-05', title: 'Okonjo settles in',
    body: '[[Bertram Okonjo]] works from the Lisbon studio, sharing the long desk by the window. He keeps the tide charts pinned above the monitor.',
  },
  {
    file: 'journal/okonjo-osaka-transfer.md', date: '2024-04-30', title: 'Okonjo transfer',
    body: '[[Bertram Okonjo]] has transferred and is now working out of the Osaka lab. The Lisbon studio keeps his old bench for visitors. His work on the sensor line continues unchanged.',
  },
  {
    file: 'journal/ferreira-joins.md', date: '2023-01-16', title: 'Ferreira joins',
    body: '[[Odalys Ferreira]] joined Meridian as a data analyst, working through the backlog of uncalibrated traces. First task: the [[Cinder Vane]] bench data.',
  },
  {
    file: 'journal/ferreira-promotion.md', date: '2025-03-07', title: 'Ferreira steps up',
    body: '[[Odalys Ferreira]] is promoted to lead of the calibration group. The role covers every instrument line, and the analyst seat she held is now open for hiring.',
  },
  {
    file: 'journal/sunward-groundbreak.md', date: '2023-09-12', title: 'Sunward Array breaks ground',
    body: 'Construction began on the [[Sunward Array]] today. Foundations first, then the panel rows. The site office is a shipping container with a kettle.',
  },
  {
    file: 'journal/sunward-commissioning.md', date: '2025-11-24', title: 'Sunward Array commissioned',
    body: 'The [[Sunward Array]] is commissioned and producing data. Every panel row reports clean. The site office container is staying as a shrine to the kettle.',
  },
  {
    file: 'journal/brasswork-open-licence.md', date: '2024-02-14', title: 'Brasswork Gate goes open',
    body: 'The [[Brasswork Gate]] is released under an open licence. Anyone can build one from the published drawings; we ask only that improvements come back upstream.',
  },
  {
    file: 'journal/brasswork-commercial.md', date: '2026-01-20', title: 'Brasswork Gate licensing change',
    body: 'A commercial licence now applies to the [[Brasswork Gate]] for manufactured units. The drawings stay published for personal builds; factories pay per unit shipped.',
  },
  // distractor journal entries — same periods, unrelated topics
  {
    file: 'journal/annual-picnic.md', date: '2024-07-19', title: 'Annual picnic',
    body: 'The picnic happened on the headland again. Someone brought a kite shaped like a squid. No instruments were harmed.',
  },
  {
    file: 'journal/badge-printer-outage.md', date: '2025-02-11', title: 'Badge printer outage',
    body: 'The badge printer jammed for a full day and the front desk issued handwritten stickers. Facilities ordered a spare roller.',
  },
  {
    file: 'journal/kitchen-repaint.md', date: '2023-11-03', title: 'Kitchen repaint',
    body: 'The kitchen is now a colour the tin calls harvest fog. Opinions are divided. The kettle is unaffected.',
  },
];

/** Undated hub pages. They describe WHAT a thing is, never what its state is. */
const HUBS = [
  {
    file: 'products/cinder-vane.md', title: 'Cinder Vane',
    body: 'The Cinder Vane is a particulate drift sensor built around a heated filament stack. Its life is recorded in the journal; this page deliberately states no status.\n\nSee also the [[Halyard Loom]].',
  },
  {
    file: 'products/halyard-loom.md', title: 'Halyard Loom',
    body: 'The Halyard Loom is the second-generation drift sensor: sealed optics, self-calibrating, field-serviceable. It descends directly from the [[Cinder Vane]] bench work.',
  },
  {
    file: 'products/brasswork-gate.md', title: 'Brasswork Gate',
    body: 'The Brasswork Gate is a passive flow regulator machined from a single casting. Licensing terms have shifted over its life; the journal records each change.',
  },
  {
    file: 'projects/sunward-array.md', title: 'Sunward Array',
    body: 'The Sunward Array is the ridge-top panel installation feeding the instrument sheds. Milestones live in the journal.',
  },
  {
    file: 'people/bertram-okonjo.md', title: 'Bertram Okonjo',
    body: 'Bertram Okonjo runs the sensor line electronics. Where he sits has changed over the years; the journal knows.',
  },
  {
    file: 'people/odalys-ferreira.md', title: 'Odalys Ferreira',
    body: 'Odalys Ferreira handles calibration across the instrument lines. Her role has grown since she joined; see the journal for the record.',
  },
  {
    file: 'vendors/foxglove-systems.md', title: 'Foxglove Systems',
    body: 'Foxglove Systems is a hosting provider with regional racks and a famously slow ticket queue.',
  },
  {
    file: 'vendors/tern-harbor.md', title: 'Tern Harbor',
    body: 'Tern Harbor is a coastal colocation provider with good peering to the survey sites.',
  },
  {
    file: 'ops/hosting.md', title: 'Hosting',
    body: 'Meridian infrastructure runs on rented racks; the provider has changed over the years and each cutover is journaled. Compute, storage, and the build fleet move together.',
  },
  {
    file: 'ops/cinder-vane-handbook.md', title: 'Cinder Vane handbook',
    body: 'Operating notes for the [[Cinder Vane]]: warm-up takes twenty minutes, the filament stack is fragile in transport, and traces need [[Odalys Ferreira]]’s calibration tables before use.',
  },
  {
    file: 'meridian.md', title: 'Meridian Works',
    body: 'Meridian Works builds slow, repairable field instruments: the [[Cinder Vane]], the [[Halyard Loom]], the [[Brasswork Gate]], and the [[Sunward Array]] site. The journal folder is the memory of the place.',
  },
];

export function buildVault3(outDir) {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  const write = (rel, body) => {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  };
  for (const j of JOURNAL) {
    write(j.file, `---\ntitle: ${j.title}\ndate: ${j.date}\n---\n\n# ${j.title}\n\n${j.body}\n`);
  }
  for (const h of HUBS) {
    write(h.file, `---\ntitle: ${h.title}\n---\n\n# ${h.title}\n\n${h.body}\n`);
  }
}
