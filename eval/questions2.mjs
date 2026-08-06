/**
 * Gold set for the Northwind Platform corpus.
 *
 * The point of a second corpus is to detect overfitting: same shipped config,
 * a vault with different link syntax, note shapes, and vocabulary. Multi-hop
 * answers here are reachable ONLY by following markdown links — the person
 * notes deliberately never name the service they own.
 */
export const questions = [
  // ── simple lookup ───────────────────────────────────────────────────────
  { id: 'N-S1', cat: 'simple', q: 'What does Quarry Cache do?',
    gold: ['platform/services/quarry-cache.md'], answer: 'read-through cache tier' },
  { id: 'N-S2', cat: 'simple', q: 'Which team is Kwabena Ofori on?',
    gold: ['people/kwabena-ofori.md'], answer: 'Batch' },
  { id: 'N-S3', cat: 'simple', q: 'What is at the bottom of the stack with no downstream dependencies?',
    gold: ['platform/services/lodestone-store.md'], answer: 'bottom of the stack' },
  { id: 'N-S4', cat: 'simple', q: 'How long did the metric cardinality explosion last?',
    gold: ['operations/incidents/2025-08-03-pinfeather.md'], answer: '2 hours 12 minutes' },
  { id: 'N-S5', cat: 'simple', q: 'What does Pinfeather handle?',
    gold: ['platform/services/pinfeather.md'], answer: 'metrics ingestion' },
  { id: 'N-S6', cat: 'simple', q: 'Which decision proposes a weighted fair queue?',
    gold: ['decisions/2025-11-18-adr-0004-batch-scheduling-fairness.md'], answer: 'weighted fair queue' },
  { id: 'N-S7', cat: 'simple', q: 'What triggered the token refresh storm incident?',
    gold: ['operations/incidents/2025-01-27-gatekeeper.md'], answer: 'token refresh storm' },
  { id: 'N-S8', cat: 'simple', q: 'What does Wickerwork do?',
    gold: ['platform/services/wickerwork.md'], answer: 'template rendering' },

  // ── multi-hop: answer note never names the query subject ────────────────
  { id: 'N-M1', cat: 'multihop', q: 'Gatekeeper owner team',
    gold: ['people/rosalind-feddersen.md'], answer: 'Edge',
    via: 'Gatekeeper -> owner link -> Rosalind Feddersen -> team' },
  { id: 'N-M2', cat: 'multihop', q: 'Quarry Cache owner team',
    gold: ['people/teodoro-blanchet.md'], answer: 'Storage',
    via: 'Quarry Cache -> owner link -> Teodoro Blanchet' },
  { id: 'N-M3', cat: 'multihop', q: 'Harbourmaster owner team',
    gold: ['people/kwabena-ofori.md'], answer: 'Batch',
    via: 'Harbourmaster -> owner link -> Kwabena Ofori' },
  { id: 'N-M4', cat: 'multihop', q: 'Pinfeather owner team',
    gold: ['people/sunniva-lindqvist.md'], answer: 'Observability',
    via: 'Pinfeather -> owner link -> Sunniva Lindqvist' },
  { id: 'N-M5', cat: 'multihop', q: 'Wickerwork owner team',
    gold: ['people/dashiell-marchetti.md'], answer: 'Web',
    via: 'Wickerwork -> owner link -> Dashiell Marchetti' },
  { id: 'N-M6', cat: 'multihop', q: 'Lodestone Store owner team',
    gold: ['people/ingrid-vasquez.md'], answer: 'Storage',
    via: 'Lodestone Store -> owner link -> Ingrid Vasquez' },

  // ── temporal ────────────────────────────────────────────────────────────
  { id: 'N-T1', cat: 'temporal', q: 'What incident happened in February 2026?',
    gold: ['operations/incidents/2026-02-14-harbourmaster.md'], answer: 'scheduler deadlock' },
  { id: 'N-T2', cat: 'temporal', q: 'Which decision was recorded in March 2024?',
    gold: ['decisions/2024-03-11-adr-0001-adopt-read-through-caching.md'], answer: 'read-through cache' },
  { id: 'N-T3', cat: 'temporal', q: 'What was the incident in May 2024?',
    gold: ['operations/incidents/2024-05-09-quarry-cache.md'], answer: 'stampede on cold start' },
  { id: 'N-T4', cat: 'temporal', q: 'Which decision was made in July 2022 about single writer per partition?',
    gold: ['decisions/2024-07-22-adr-0002-single-writer-per-partition.md'], answer: 'exactly one leader' },
  { id: 'N-T5', cat: 'temporal', q: 'What happened in the August 2025 incident?',
    gold: ['operations/incidents/2025-08-03-pinfeather.md'], answer: 'cardinality explosion' },

  // ── aggregate / structural ──────────────────────────────────────────────
  { id: 'N-A1', cat: 'aggregate', q: 'Which decisions are still only proposed?',
    gold: ['decisions/2025-11-18-adr-0004-batch-scheduling-fairness.md'], answer: 'weighted fair queue' },
  { id: 'N-A2', cat: 'aggregate', q: 'Which decision has been superseded?',
    gold: ['decisions/2025-02-04-adr-0003-retire-the-legacy-rendering-path.md'], answer: 'retired' },
  { id: 'N-A3', cat: 'aggregate', q: 'Which service does Gatekeeper call on the hot path?',
    gold: ['platform/services/gatekeeper.md'], answer: 'Quarry Cache' },
  { id: 'N-A4', cat: 'aggregate', q: 'Who has been on the platform longest?',
    gold: ['people/ingrid-vasquez.md'], answer: '2018-02-19' },
  { id: 'N-A5', cat: 'aggregate', q: 'What is the escalation procedure for Lodestone Store?',
    gold: ['operations/runbooks/lodestone-store-runbook.md'], answer: 'Page the owning team' },
];
