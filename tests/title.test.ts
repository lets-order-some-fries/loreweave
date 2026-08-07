import { describe, expect, it } from 'vitest';
import { parseNote, resolveTitle } from '../src/vault/parse.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { queryFacts } from '../src/facts/model.js';
import { makeVault } from './helpers.js';

describe('resolveTitle', () => {
  it('prefers explicit frontmatter title, then name', () => {
    expect(resolveTitle('a/b.md', { title: 'Real Title' })).toBe('Real Title');
    expect(resolveTitle('a/b.md', { name: 'from-name' })).toBe('from-name');
    expect(resolveTitle('a/b.md', { title: '  ', name: 'from-name' })).toBe('from-name');
  });

  it('uses the parent folder when the filename only states a role', () => {
    // dozens of files share these names; the folder is what identifies them
    expect(resolveTitle('skills/writing-skills/SKILL.md', {})).toBe('writing-skills');
    expect(resolveTitle('projects/atlas/README.md', {})).toBe('atlas');
    expect(resolveTitle('docs/api/index.md', {})).toBe('api');
  });

  it('keeps a meaningful filename', () => {
    expect(resolveTitle('people/amara-osei.md', {})).toBe('amara-osei');
  });

  it('falls back safely at the vault root', () => {
    expect(resolveTitle('README.md', {})).toBe('README');
  });
});

describe('identically-named notes stay distinct', () => {
  it('does not collapse many SKILL.md files into one subject', async () => {
    // Measured on a real corpus: 39 SKILL.md files produced ONE fact subject,
    // whose facts then superseded each other arbitrarily.
    const root = await makeVault({
      'sp/alpha/SKILL.md': '---\nname: alpha\nstatus: stable\n---\n\n# Alpha\n\nBody.\n',
      'sp/beta/SKILL.md': '---\nname: beta\nstatus: draft\n---\n\n# Beta\n\nBody.\n',
      'sp/gamma/SKILL.md': '---\nname: gamma\nstatus: stable\n---\n\n# Gamma\n\nBody.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);

    const subjects = new Set(
      queryFacts(store, { includeHistory: true }).map((f) => f.subject),
    );
    expect(subjects.has('alpha')).toBe(true);
    expect(subjects.has('beta')).toBe(true);
    expect(subjects.has('gamma')).toBe(true);
    // nothing superseded anything: three separate slots
    const statuses = queryFacts(store, { predicate: 'status' });
    expect(statuses).toHaveLength(3);
    store.close();
  });

  it('README.md in different folders are different notes', async () => {
    const root = await makeVault({
      'a/README.md': '# A\n\nAlpha readme.\n',
      'b/README.md': '# B\n\nBeta readme.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const titles = (store.db.prepare('SELECT title FROM notes ORDER BY title').all() as { title: string }[])
      .map((r) => r.title);
    expect(titles).toEqual(['a', 'b']);
    store.close();
  });

  it('parseNote applies the same rule', () => {
    expect(parseNote('sp/writing-skills/SKILL.md', '# Heading\n\nBody\n', 1).title).toBe(
      'writing-skills',
    );
  });
});
