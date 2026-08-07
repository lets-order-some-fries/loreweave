/**
 * Second eval corpus: "Northwind Platform" engineering knowledge base.
 *
 * Deliberately unlike the Kestrel Basin vault in every dimension that the
 * retrieval config could have been overfitted to:
 *   - markdown links [text](../path.md), not [[wiki links]]
 *   - deep folder nesting, kebab-case filenames unrelated to titles
 *   - frontmatter facts (status/owner) and dated filenames
 *   - note shapes real engineering vaults use: ADRs, runbooks, incidents,
 *     meeting notes — not uniform entity pages
 *   - prose that repeats platform jargon, so lexical competition is real
 *
 * If the shipped config only wins on Kestrel Basin, it is tuned to a
 * benchmark rather than to retrieval.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVICES = [
  { id: 'gatekeeper', title: 'Gatekeeper', role: 'edge authentication', owner: 'Rosalind Feddersen', dep: 'quarry-cache' },
  { id: 'quarry-cache', title: 'Quarry Cache', role: 'read-through cache tier', owner: 'Teodoro Blanchet', dep: 'lodestone-store' },
  { id: 'lodestone-store', title: 'Lodestone Store', role: 'primary durable storage', owner: 'Ingrid Vasquez', dep: null },
  { id: 'harbourmaster', title: 'Harbourmaster', role: 'job scheduling', owner: 'Kwabena Ofori', dep: 'lodestone-store' },
  { id: 'pinfeather', title: 'Pinfeather', role: 'metrics ingestion', owner: 'Sunniva Lindqvist', dep: 'quarry-cache' },
  { id: 'wickerwork', title: 'Wickerwork', role: 'template rendering', owner: 'Dashiell Marchetti', dep: 'gatekeeper' },
];

const PEOPLE = [
  { id: 'rosalind-feddersen', name: 'Rosalind Feddersen', team: 'Edge', joined: '2021-04-12' },
  { id: 'teodoro-blanchet', name: 'Teodoro Blanchet', team: 'Storage', joined: '2019-09-02' },
  { id: 'ingrid-vasquez', name: 'Ingrid Vasquez', team: 'Storage', joined: '2018-02-19' },
  { id: 'kwabena-ofori', name: 'Kwabena Ofori', team: 'Batch', joined: '2022-06-01' },
  { id: 'sunniva-lindqvist', name: 'Sunniva Lindqvist', team: 'Observability', joined: '2020-11-30' },
  { id: 'dashiell-marchetti', name: 'Dashiell Marchetti', team: 'Web', joined: '2023-01-09' },
];

const FILLER = [
  'The platform runs three regions with an active-active posture and a shared control plane.',
  'Every deploy goes through the staged pipeline: canary, one region, then the rest.',
  'Rollbacks are expected to complete inside ten minutes or the release is considered failed.',
  'Capacity planning is revisited each quarter against the previous peak plus forty percent.',
  'On-call rotation is one week, handover on Wednesday mornings.',
  'All services emit structured logs with a shared correlation identifier.',
  'Configuration lives in the platform repository and is reviewed like code.',
];

export function buildVault2(outDir, { quiet = true } = {}) {
  const OUT = outDir;
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  const written = [];
  const write = (rel, body) => {
    const abs = join(OUT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
    written.push(rel);
  };
  const pick = (i) => FILLER[i % FILLER.length];
  const personPath = (id) => `people/${id}.md`;
  const servicePath = (id) => `platform/services/${id}.md`;

  // services — link to owner + dependency via MARKDOWN links, relative paths
  SERVICES.forEach((s, i) => {
    const ownerId = PEOPLE.find((p) => p.name === s.owner).id;
    const dep = s.dep ? SERVICES.find((x) => x.id === s.dep) : null;
    write(
      servicePath(s.id),
      `---\ntitle: ${s.title}\ntype: service\nstatus: operational\nowner: ${s.owner}\n---\n\n` +
        `# ${s.title}\n\n${s.title} handles ${s.role} for the platform.\n\n` +
        `${pick(i)} ${pick(i + 3)}\n\n` +
        `## Ownership\n\nMaintained by [${s.owner}](../../people/${ownerId}.md).\n\n` +
        (dep
          ? `## Dependencies\n\nCalls [${dep.title}](./${dep.id}.md) on the hot path.\n`
          : `## Dependencies\n\nNo downstream dependencies; this is the bottom of the stack.\n`),
    );
  });

  // people — no mention of the services they own (multi-hop must go via links)
  PEOPLE.forEach((p, i) => {
    write(
      personPath(p.id),
      `---\ntitle: ${p.name}\ntype: person\nteam: ${p.team}\njoined: ${p.joined}\n---\n\n` +
        `# ${p.name}\n\n${p.name} works on the ${p.team} team.\n\n${pick(i + 1)}\n`,
    );
  });

  // ADRs — decisions with status frontmatter and dated filenames
  const adrs = [
    { n: '0001', date: '2024-03-11', title: 'Adopt read-through caching', status: 'accepted', svc: 'quarry-cache',
      body: 'We accepted a read-through cache in front of durable storage to cut tail latency at the ninety-ninth percentile.' },
    { n: '0002', date: '2024-07-22', title: 'Single writer per partition', status: 'accepted', svc: 'lodestone-store',
      body: 'Each partition accepts writes from exactly one leader, which removes the reconciliation path entirely.' },
    { n: '0003', date: '2025-02-04', title: 'Retire the legacy rendering path', status: 'superseded', svc: 'wickerwork',
      body: 'The old rendering path was retired in favour of streamed templates.' },
    { n: '0004', date: '2025-11-18', title: 'Batch scheduling fairness', status: 'proposed', svc: 'harbourmaster',
      body: 'A weighted fair queue is proposed so that one tenant cannot starve the others during backlog drain.' },
  ];
  adrs.forEach((a, i) => {
    const svc = SERVICES.find((s) => s.id === a.svc);
    write(
      `decisions/${a.date}-adr-${a.n}-${a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
      `---\ntitle: "ADR ${a.n}: ${a.title}"\ntype: decision\nstatus: ${a.status}\ndate: ${a.date}\n---\n\n` +
        `# ADR ${a.n}: ${a.title}\n\n${a.body}\n\n${pick(i + 2)}\n\n` +
        `## Affected component\n\nApplies to [${svc.title}](../platform/services/${svc.id}.md).\n`,
    );
  });

  // incidents — dated, reference a service, contain the distinctive symptom
  const incidents = [
    { date: '2024-05-09', svc: 'quarry-cache', sym: 'stampede on cold start', dur: '41 minutes' },
    { date: '2025-01-27', svc: 'gatekeeper', sym: 'token refresh storm', dur: '18 minutes' },
    { date: '2025-08-03', svc: 'pinfeather', sym: 'metric cardinality explosion', dur: '2 hours 12 minutes' },
    { date: '2026-02-14', svc: 'harbourmaster', sym: 'scheduler deadlock under backlog', dur: '55 minutes' },
  ];
  incidents.forEach((inc, i) => {
    const svc = SERVICES.find((s) => s.id === inc.svc);
    write(
      `operations/incidents/${inc.date}-${inc.svc}.md`,
      `---\ntitle: Incident ${inc.date} ${svc.title}\ntype: incident\ndate: ${inc.date}\nseverity: sev2\n---\n\n` +
        `# Incident ${inc.date}\n\nCustomer impact lasted ${inc.dur}. The trigger was a ${inc.sym}.\n\n` +
        `${pick(i + 4)}\n\n## Component\n\n[${svc.title}](../../platform/services/${svc.id}.md) was the failing component.\n`,
    );
  });

  // runbooks — operational prose, heavy jargon overlap for lexical competition
  SERVICES.forEach((s, i) => {
    write(
      `operations/runbooks/${s.id}-runbook.md`,
      `---\ntitle: ${s.title} runbook\ntype: runbook\n---\n\n` +
        `# ${s.title} runbook\n\nStandard operating procedure for ${s.title}.\n\n` +
        `${pick(i)} ${pick(i + 5)}\n\n` +
        `## Escalation\n\nPage the owning team, then [${s.title}](../../platform/services/${s.id}.md) owner.\n`,
    );
  });

  // meeting notes — dated, low signal, exist to create lexical noise
  ['2025-03-05', '2025-06-11', '2025-09-24', '2026-01-15', '2026-04-08'].forEach((d, i) => {
    write(
      `meetings/${d}-platform-sync.md`,
      `---\ntitle: Platform sync ${d}\ntype: meeting\ndate: ${d}\n---\n\n` +
        `# Platform sync ${d}\n\n${pick(i)} ${pick(i + 2)} ${pick(i + 4)}\n\n` +
        `Discussed capacity, deploys, and the on-call rotation. No decisions recorded.\n`,
    );
  });

  if (!quiet) console.log(`wrote ${written.length} notes to ${OUT}`);
  return { notes: written.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildVault2(process.argv[2] ?? join(dirname(new URL(import.meta.url).pathname), '..', 'vault2'), { quiet: false });
}
