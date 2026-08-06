import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { queryFacts } from '../src/facts/model.js';
import { extractFactsFromNote } from '../src/facts/extract.js';
import { parseNote } from '../src/vault/parse.js';
import { makeVault } from './helpers.js';

describe('fact extraction tiers', () => {
  it('reads frontmatter, inline fields and observations; skips file metadata', () => {
    const raw = `---
title: Ledger Format
status: draft
tags: [infra, storage]
---

# Ledger

- owner:: Priya Sharma
- [format] columnar
- **Deputy:** Sam Okoro
`;
    const explicit = extractFactsFromNote(parseNote('a.md', raw, 1));
    const keys = explicit.map((f) => `${f.predicate}=${f.object}`);
    expect(keys).toContain('status=draft');
    expect(keys).toContain('owner=Priya Sharma');
    expect(keys).toContain('format=columnar');
    // title/tags describe the file, not the thing
    expect(explicit.some((f) => f.predicate === 'title')).toBe(false);
    expect(explicit.some((f) => f.predicate === 'tags')).toBe(false);
    // prose formatting is opt-in
    expect(keys).not.toContain('Deputy=Sam Okoro');
    const all = extractFactsFromNote(parseNote('a.md', raw, 1), 'all');
    expect(all.map((f) => `${f.predicate}=${f.object}`)).toContain('Deputy=Sam Okoro');
  });

  it('task list items are never facts', () => {
    const raw = `---\ntitle: PR\n---\n\n- [x] Bug fix (non-breaking change)\n- [ ] New feature\n`;
    const facts = extractFactsFromNote(parseNote('pr.md', raw, 1), 'all');
    expect(facts.some((f) => f.predicate === 'x' || f.predicate === '')).toBe(false);
    expect(facts).toHaveLength(0);
  });

  it('a frontmatter date becomes valid_from, so as-of can see it', async () => {
    // gray-matter yields a Date; JSON storage makes it a datetime string —
    // a date-only check silently dropped it.
    const root = await makeVault({
      'l.md': '---\ntitle: Ledger\nstatus: draft\ndate: 2026-01-15\n---\n\n# Ledger\n\nBody.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const now = queryFacts(store, { subject: 'Ledger' });
    expect(now[0]!.validFrom).toBe('2026-01-15');
    expect(queryFacts(store, { subject: 'Ledger', asOf: '2026-06-01' })).toHaveLength(1);
    expect(queryFacts(store, { subject: 'Ledger', asOf: '2025-06-01' })).toHaveLength(0);
    store.close();
  });

  it('an explicit [fact] line beats an extracted one for the same slot', async () => {
    const root = await makeVault({
      'l.md': '---\ntitle: Ledger\nstatus: draft\n---\n\n# Ledger\n\nBody.\n',
      'lore/journal/2026-08-01.md':
        '# J\n\n- [fact] Ledger :: status :: shipped {valid_from=2026-08-01}\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const rows = queryFacts(store, { subject: 'Ledger', predicate: 'status', includeHistory: true });
    expect(rows.map((r) => r.object)).toEqual(['shipped']);
    expect(rows[0]!.sourceType).toBe('stated');
    store.close();
  });
});
