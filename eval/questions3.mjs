/**
 * Gold-standard eval set over the Meridian Works vault.
 *
 * Three abilities, none of which the other two corpora measure:
 *
 *   temporal — the query names a window; the correct note is the one DATED
 *              inside it. Dates exist only in frontmatter, so lexical match
 *              cannot answer these by accident.
 *   flip     — perturbation pairs: the same question with a shifted window
 *              has a different correct note. TimeQA-style analyses show
 *              systems ~66% consistent under exactly this perturbation when
 *              lexical overlap is allowed to dominate; a system that gets
 *              one direction right and the other wrong is pattern-matching,
 *              not time-scoping.
 *   current  — knowledge-update: several notes state values that were each
 *              true once; the correct answer is the newest. Recorded as
 *              honest headroom — retrieval has no content-recency preference
 *              yet, and the baseline should say so rather than hide it.
 */
export const questions = [
  // ── temporal: windowed queries ──────────────────────────────────────────
  { id: 'M-T1', cat: 'temporal', q: 'Cinder Vane in 2023',
    gold: ['journal/cinder-vane-first-light.md'], answer: 'prototype' },
  { id: 'M-T2', cat: 'temporal', q: 'what happened with the Cinder Vane in June 2024',
    gold: ['journal/cinder-vane-pilot-review.md'], answer: 'pilot' },
  { id: 'M-T3', cat: 'temporal', q: 'who hosted Meridian infrastructure in 2023',
    gold: ['journal/hosting-foxglove-cutover.md'], answer: 'Foxglove' },
  { id: 'M-T4', cat: 'temporal', q: 'Sunward Array progress in September 2023',
    gold: ['journal/sunward-groundbreak.md'], answer: 'Construction began' },
  { id: 'M-T5', cat: 'temporal', q: 'Brasswork Gate licence in February 2024',
    gold: ['journal/brasswork-open-licence.md'], answer: 'open licence' },
  { id: 'M-T6', cat: 'temporal', q: 'Odalys Ferreira in 2023',
    gold: ['journal/ferreira-joins.md'], answer: 'analyst' },
  { id: 'M-T7', cat: 'temporal', q: 'what changed for Meridian hosting in August 2025',
    gold: ['journal/hosting-tern-harbor-move.md'], answer: 'Tern Harbor' },
  { id: 'M-T8', cat: 'temporal', q: 'Sunward Array in November 2025',
    gold: ['journal/sunward-commissioning.md'], answer: 'commissioned' },

  // ── flip: same question, shifted window, DIFFERENT correct answer ───────
  { id: 'M-F1a', cat: 'flip', q: 'where did Bertram Okonjo work before 2024',
    gold: ['journal/okonjo-lisbon-desk.md'], answer: 'Lisbon' },
  { id: 'M-F1b', cat: 'flip', q: 'where did Bertram Okonjo work since 2024',
    gold: ['journal/okonjo-osaka-transfer.md'], answer: 'Osaka' },
  { id: 'M-F2a', cat: 'flip', q: 'Cinder Vane status in 2024',
    gold: ['journal/cinder-vane-pilot-review.md'], answer: 'pilot' },
  { id: 'M-F2b', cat: 'flip', q: 'Cinder Vane status in 2026',
    gold: ['journal/cinder-vane-retirement.md'], answer: 'retired' },
  { id: 'M-F3a', cat: 'flip', q: 'Brasswork Gate licence terms in 2024',
    gold: ['journal/brasswork-open-licence.md'], answer: 'open licence' },
  { id: 'M-F3b', cat: 'flip', q: 'Brasswork Gate licence terms in 2026',
    gold: ['journal/brasswork-commercial.md'], answer: 'commercial' },

  // ── current: knowledge-update headroom ──────────────────────────────────
  { id: 'M-C1', cat: 'current', q: 'what is the current status of the Cinder Vane',
    gold: ['journal/cinder-vane-retirement.md'], answer: 'retired' },
  { id: 'M-C2', cat: 'current', q: 'who hosts Meridian infrastructure now',
    gold: ['journal/hosting-tern-harbor-move.md'], answer: 'Tern Harbor' },
  { id: 'M-C3', cat: 'current', q: 'what is Odalys Ferreira’s role today',
    gold: ['journal/ferreira-promotion.md'], answer: 'calibration group' },
  { id: 'M-C4', cat: 'current', q: 'which licence applies to the Brasswork Gate now',
    gold: ['journal/brasswork-commercial.md'], answer: 'commercial' },
];
