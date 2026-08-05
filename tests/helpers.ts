import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Create a temp vault from a {relPath: content} map. Returns its root. */
export async function makeVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lw-vault-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return root;
}

/** Overwrite a file and bump mtime so the indexer sees the change. */
export async function editFile(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  const future = new Date(Date.now() + 5000);
  await utimes(abs, future, future);
}

/**
 * Fixture vault with a multi-hop trap:
 * "riverbed protocol" (query) connects to "glacier dataset" only through the
 * bridge note about Dr. Amara Osei. A decoy note repeats query words with no
 * real connection.
 */
export const FIXTURE_VAULT: Record<string, string> = {
  'projects/riverbed.md': `---
title: Riverbed Protocol
tags: [research]
---

# Overview

The Riverbed Protocol is our experiment design for streaming compaction.
It was designed together with [[Amara Osei]] during the winter sprint.

# Status

Currently blocked on storage costs.
`,
  'people/amara-osei.md': `---
title: Amara Osei
---

Dr. Amara Osei leads the hydrology group. She maintains the [[Glacier Dataset]]
and advises the [[Riverbed Protocol]] work.
`,
  'data/glacier-dataset.md': `---
title: Glacier Dataset
---

The Glacier Dataset holds meltwater sensor readings from 2019-2024.
Access requires signing the data agreement.
`,
  'misc/decoy.md': `---
title: Decoy Note
---

Riverbed riverbed riverbed protocol protocol protocol. This note repeats the
words riverbed and protocol many times but riverbed protocol connects to
nothing else. Riverbed protocol riverbed protocol.
`,
  'notes/unrelated.md': `---
title: Grocery Plans
---

Buy oat milk and lentils. Completely unrelated content.
`,
  'lore/journal/2026-08-01.md': `# Journal

- [fact] Ambuj :: works_at :: Motherson {valid_from=2025-11-01, recorded_at=2026-08-01T10:00:00.000Z}
- [fact] Riverbed Protocol :: status :: blocked {valid_from=2026-07-20, recorded_at=2026-08-01T10:00:00.000Z}
`,
};
