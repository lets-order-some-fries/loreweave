import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { LoreContext } from '../context.js';
import { normalizeKey } from '../normalize.js';
import { daysBetween, retrievability } from '../dynamics/fsrs.js';

/**
 * Idle-time consolidation ("dreaming"): the engine reviews its own state and
 * emits a report of duplicates, contradictions, stale knowledge, missing
 * links, and orphans. Passes are deterministic; nothing here rewrites user
 * prose (the ACE anti-collapse rule). `apply` writes ONLY new files under
 * the lore/ namespace: a digest and a review-queue note.
 */

export interface DuplicateFinding {
  a: { notePath: string; anchor: string };
  b: { notePath: string; anchor: string };
  jaccard: number;
}

export interface ContradictionFinding {
  subject: string;
  predicate: string;
  objects: string[];
  kind: 'contested' | 'recent-supersession';
  detail: string;
}

export interface StaleFinding {
  kind: 'block' | 'fact';
  ref: string;
  importance?: number;
  retrievability?: number;
  detail: string;
}

export interface LinkSuggestion {
  from: string;
  to: string;
  sharedEntities: string[];
}

export interface DreamReport {
  generatedAt: string;
  stats: {
    notes: number;
    blocks: number;
    entities: number;
    facts: number;
    openFacts: number;
    accessEvents: number;
  };
  duplicates: DuplicateFinding[];
  contradictions: ContradictionFinding[];
  stale: StaleFinding[];
  linkSuggestions: LinkSuggestion[];
  orphans: string[];
  written: string[];
}

const SHINGLE = 8;
const JACCARD_THRESHOLD = 0.85;

function shingles(text: string): Set<string> {
  const tokens = normalizeKey(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) {
    out.add(tokens.slice(i, i + SHINGLE).join(' '));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

function findDuplicates(ctx: LoreContext): DuplicateFinding[] {
  const rows = ctx.store.db
    .prepare(`SELECT id, note_path, anchor, text, hash FROM blocks WHERE archived=0`)
    .all() as { id: number; note_path: string; anchor: string; text: string; hash: string }[];
  const out: DuplicateFinding[] = [];
  const seen = new Set<string>();

  // exact duplicates by hash (cross-note only)
  const byHash = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byHash.get(r.hash);
    if (arr) arr.push(r);
    else byHash.set(r.hash, [r]);
  }
  for (const group of byHash.values()) {
    for (let i = 1; i < group.length; i++) {
      if (group[0]!.note_path === group[i]!.note_path) continue;
      out.push({
        a: { notePath: group[0]!.note_path, anchor: group[0]!.anchor },
        b: { notePath: group[i]!.note_path, anchor: group[i]!.anchor },
        jaccard: 1,
      });
      seen.add(`${group[0]!.id}-${group[i]!.id}`);
    }
  }

  // near-duplicates via shared-shingle buckets (avoids full O(n²))
  const sh = rows.map((r) => ({ r, s: shingles(r.text) }));
  const bucket = new Map<string, number[]>();
  sh.forEach((e, i) => {
    for (const g of e.s) {
      const arr = bucket.get(g);
      if (arr) arr.push(i);
      else bucket.set(g, [i]);
    }
  });
  const candidatePairs = new Set<string>();
  for (const arr of bucket.values()) {
    if (arr.length < 2 || arr.length > 20) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        candidatePairs.add(`${arr[i]}:${arr[j]}`);
      }
    }
  }
  for (const pair of candidatePairs) {
    const [iStr, jStr] = pair.split(':');
    const A = sh[Number(iStr)]!;
    const B = sh[Number(jStr)]!;
    if (A.r.note_path === B.r.note_path) continue;
    if (seen.has(`${A.r.id}-${B.r.id}`) || seen.has(`${B.r.id}-${A.r.id}`)) continue;
    const J = jaccard(A.s, B.s);
    if (J >= JACCARD_THRESHOLD && J < 1) {
      out.push({
        a: { notePath: A.r.note_path, anchor: A.r.anchor },
        b: { notePath: B.r.note_path, anchor: B.r.anchor },
        jaccard: Number(J.toFixed(3)),
      });
    }
  }
  return out.slice(0, 50);
}

function findContradictions(ctx: LoreContext): ContradictionFinding[] {
  const db = ctx.store.db;
  const out: ContradictionFinding[] = [];
  // contested: same slot, same effective start, different objects
  const contested = db
    .prepare(
      `SELECT subject, predicate, COALESCE(valid_from, recorded_at) AS start,
              GROUP_CONCAT(object, ' ||| ') AS objs, COUNT(*) AS c
       FROM facts GROUP BY subject, predicate, start HAVING c > 1`,
    )
    .all() as { subject: string; predicate: string; start: string; objs: string }[];
  for (const r of contested) {
    const objects = [...new Set(r.objs.split(' ||| '))];
    if (objects.length < 2) continue;
    out.push({
      subject: r.subject,
      predicate: r.predicate,
      objects,
      kind: 'contested',
      detail: `both asserted effective ${r.start} — needs a human ruling`,
    });
  }
  // recent supersessions (last 14 days): surfaced so changes are visible
  const recent = db
    .prepare(
      `SELECT f.subject, f.predicate, f.object AS oldObj, g.object AS newObj, f.superseded_at
       FROM facts f JOIN facts g ON g.id = f.superseded_by
       WHERE f.superseded_at IS NOT NULL AND f.superseded_at >= ?`,
    )
    .all(new Date(Date.now() - 14 * 86_400_000).toISOString()) as {
    subject: string;
    predicate: string;
    oldObj: string;
    newObj: string;
    superseded_at: string;
  }[];
  for (const r of recent) {
    out.push({
      subject: r.subject,
      predicate: r.predicate,
      objects: [r.oldObj, r.newObj],
      kind: 'recent-supersession',
      detail: `"${r.oldObj}" → "${r.newObj}" (${r.superseded_at.slice(0, 10)})`,
    });
  }
  return out;
}

function findStale(ctx: LoreContext): StaleFinding[] {
  const now = new Date();
  const out: StaleFinding[] = [];
  const blocks = ctx.store.db
    .prepare(
      `SELECT note_path, anchor, importance, stability, last_accessed
       FROM blocks WHERE archived=0 AND importance >= 0.6`,
    )
    .all() as {
    note_path: string;
    anchor: string;
    importance: number;
    stability: number;
    last_accessed: string | null;
  }[];
  for (const b of blocks) {
    if (!b.last_accessed) continue; // never accessed → nothing decayed yet
    const R = retrievability(daysBetween(b.last_accessed, now), b.stability);
    if (R < 0.3) {
      out.push({
        kind: 'block',
        ref: `${b.note_path}#${b.anchor}`,
        importance: b.importance,
        retrievability: Number(R.toFixed(3)),
        detail: 'important but fading — revisit or archive',
      });
    }
  }
  const oldFacts = ctx.store.db
    .prepare(
      `SELECT subject_display, predicate, object, COALESCE(valid_from, recorded_at) AS start
       FROM facts WHERE valid_until IS NULL AND superseded_by IS NULL
       AND COALESCE(valid_from, recorded_at) <= ?`,
    )
    .all(new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10)) as {
    subject_display: string;
    predicate: string;
    object: string;
    start: string;
  }[];
  for (const f of oldFacts) {
    out.push({
      kind: 'fact',
      ref: `${f.subject_display} :: ${f.predicate} :: ${f.object}`,
      detail: `open since ${f.start.slice(0, 10)} — still true?`,
    });
  }
  return out.slice(0, 50);
}

function findLinkSuggestions(ctx: LoreContext): LinkSuggestion[] {
  const db = ctx.store.db;
  // note pairs sharing ≥2 high-confidence entities, with no wiki-link between them
  const rows = db
    .prepare(
      `SELECT m1.note_path AS a, m2.note_path AS b, e.key
       FROM mentions m1
       JOIN mentions m2 ON m1.entity_id = m2.entity_id AND m1.note_path < m2.note_path
       JOIN entities e ON e.id = m1.entity_id
       WHERE m1.confidence >= 0.6 AND m2.confidence >= 0.6`,
    )
    .all() as { a: string; b: string; key: string }[];
  const shared = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = `${r.a} ${r.b}`;
    const set = shared.get(k);
    if (set) set.add(r.key);
    else shared.set(k, new Set([r.key]));
  }
  // existing links (either direction) by normalized note identity
  const notes = db.prepare(`SELECT path, title FROM notes`).all() as {
    path: string;
    title: string;
  }[];
  const keyToPath = new Map<string, string>();
  for (const n of notes) {
    keyToPath.set(normalizeKey(n.title), n.path);
    keyToPath.set(normalizeKey(n.path.split('/').pop() ?? n.path), n.path);
  }
  const linked = new Set<string>();
  const links = db.prepare(`SELECT note_path, target_norm FROM links`).all() as {
    note_path: string;
    target_norm: string;
  }[];
  for (const l of links) {
    const dst = keyToPath.get(l.target_norm);
    if (!dst) continue;
    linked.add(`${l.note_path} ${dst}`);
    linked.add(`${dst} ${l.note_path}`);
  }
  const out: LinkSuggestion[] = [];
  for (const [pair, entities] of shared) {
    if (entities.size < 2) continue;
    if (linked.has(pair)) continue;
    const [a, b] = pair.split(' ');
    // note-title entities of each other don't count as evidence
    const meaningful = [...entities].filter(
      (e) => keyToPath.get(e) !== a && keyToPath.get(e) !== b,
    );
    if (meaningful.length < 2) continue;
    out.push({ from: a!, to: b!, sharedEntities: meaningful.slice(0, 6) });
  }
  out.sort((x, y) => y.sharedEntities.length - x.sharedEntities.length);
  return out.slice(0, 30);
}

function findOrphans(ctx: LoreContext): string[] {
  const db = ctx.store.db;
  const notes = db.prepare(`SELECT path, title FROM notes`).all() as {
    path: string;
    title: string;
  }[];
  const keyToPath = new Map<string, string>();
  for (const n of notes) {
    keyToPath.set(normalizeKey(n.title), n.path);
    keyToPath.set(normalizeKey(n.path.split('/').pop() ?? n.path), n.path);
  }
  const hasLink = new Set<string>();
  const links = db.prepare(`SELECT note_path, target_norm FROM links`).all() as {
    note_path: string;
    target_norm: string;
  }[];
  for (const l of links) {
    hasLink.add(l.note_path);
    const dst = keyToPath.get(l.target_norm);
    if (dst) hasLink.add(dst);
  }
  return notes
    .map((n) => n.path)
    .filter((p) => !hasLink.has(p) && !p.startsWith('lore/'))
    .slice(0, 50);
}

export function dream(ctx: LoreContext, opts: { apply?: boolean } = {}): DreamReport {
  const db = ctx.store.db;
  const count = (sql: string): number => (db.prepare(sql).get() as any).c as number;
  const report: DreamReport = {
    generatedAt: new Date().toISOString(),
    stats: {
      notes: count(`SELECT COUNT(*) c FROM notes`),
      blocks: count(`SELECT COUNT(*) c FROM blocks`),
      entities: count(`SELECT COUNT(*) c FROM entities`),
      facts: count(`SELECT COUNT(*) c FROM facts`),
      openFacts: count(
        `SELECT COUNT(*) c FROM facts WHERE valid_until IS NULL AND superseded_by IS NULL`,
      ),
      accessEvents: count(`SELECT COUNT(*) c FROM access_log`),
    },
    duplicates: findDuplicates(ctx),
    contradictions: findContradictions(ctx),
    stale: findStale(ctx),
    linkSuggestions: findLinkSuggestions(ctx),
    orphans: findOrphans(ctx),
    written: [],
  };

  if (opts.apply) {
    const date = report.generatedAt.slice(0, 10);
    const digestRel = `lore/digests/${date}.md`;
    const digestAbs = join(ctx.root, digestRel);
    mkdirSync(dirname(digestAbs), { recursive: true });
    // append-only: never overwrite an existing digest silently
    if (!existsSync(digestAbs)) {
      appendFileSync(digestAbs, renderDigest(report), 'utf8');
      report.written.push(digestRel);
    }
    const queueRel = `lore/review-queue.md`;
    const queueAbs = join(ctx.root, queueRel);
    appendFileSync(queueAbs, renderReviewQueue(report), 'utf8');
    report.written.push(queueRel);
  }
  return report;
}

export function renderDigest(r: DreamReport): string {
  const s = r.stats;
  return `---
title: Lore Digest ${r.generatedAt.slice(0, 10)}
tags: [lore-digest]
---

# Vault digest — ${r.generatedAt.slice(0, 10)}

${s.notes} notes · ${s.blocks} blocks · ${s.entities} entities · ${s.openFacts}/${s.facts} facts open · ${s.accessEvents} access events.

- Duplicate passages: ${r.duplicates.length}
- Contradictions / recent changes: ${r.contradictions.length}
- Stale items needing review: ${r.stale.length}
- Suggested missing links: ${r.linkSuggestions.length}
- Orphan notes: ${r.orphans.length}

See lore/review-queue.md for the actionable list.
`;
}

export function renderReviewQueue(r: DreamReport): string {
  const lines: string[] = [`\n## Review — ${r.generatedAt.slice(0, 10)}\n`];
  for (const c of r.contradictions) {
    lines.push(`- [ ] ${c.kind}: **${c.subject} :: ${c.predicate}** — ${c.detail}`);
  }
  for (const s of r.stale) {
    lines.push(`- [ ] stale ${s.kind}: ${s.ref} — ${s.detail}`);
  }
  for (const d of r.duplicates) {
    lines.push(
      `- [ ] duplicate: ${d.a.notePath}#${d.a.anchor} ≈ ${d.b.notePath}#${d.b.anchor} (J=${d.jaccard})`,
    );
  }
  for (const l of r.linkSuggestions) {
    lines.push(
      `- [ ] link? [[${l.from}]] ↔ [[${l.to}]] (shared: ${l.sharedEntities.join(', ')})`,
    );
  }
  for (const o of r.orphans) {
    lines.push(`- [ ] orphan: [[${o}]] — no links in or out`);
  }
  if (lines.length === 1) lines.push('- nothing to review 🎉');
  return lines.join('\n') + '\n';
}
