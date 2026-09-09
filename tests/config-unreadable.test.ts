import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openContext } from '../src/context.js';

/**
 * loadConfig caught every readFileSync error as if it were "no config file"
 * and returned defaults. Measured: a config with embedding.provider ollama,
 * chmod 000 — `lore stats` ran, on defaults, with no message. A vault set up
 * for dense retrieval quietly ran without it. Only ENOENT means "no config".
 */
async function vaultWith(config: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lw-cfg-read-'));
  await mkdir(join(root, '.lore'), { recursive: true });
  if (config !== null) await writeFile(join(root, '.lore', 'config.json'), config);
  return root;
}

describe('an unreadable config', () => {
  it('a missing file still means defaults', async () => {
    const root = await vaultWith(null);
    expect(loadConfig(root).embedding.provider).toBe('none');
  });

  it('a file that cannot be read is an error naming the file, not defaults', async () => {
    const root = await vaultWith(JSON.stringify({ embedding: { provider: 'ollama' } }));
    const file = join(root, '.lore', 'config.json');
    await chmod(file, 0o000);
    try {
      expect(() => loadConfig(root)).toThrow(/config\.json/);
      expect(() => loadConfig(root)).toThrow(/EACCES|permission denied/);
      // and the vault does not open on defaults behind the user's back
      expect(() => openContext(root)).toThrow(/config\.json/);
    } finally {
      await chmod(file, 0o644);
    }
    // readable again: the real config is honoured
    expect(loadConfig(root).embedding.provider).toBe('ollama');
  });

  it('a directory where the file should be is an error too', async () => {
    const root = await vaultWith(null);
    await mkdir(join(root, '.lore', 'config.json'));
    expect(() => loadConfig(root)).toThrow(/config\.json/);
    expect(() => loadConfig(root)).toThrow(/EISDIR|directory/);
  });

  it('invalid JSON is still refused loudly', async () => {
    const root = await vaultWith('{ not json');
    expect(() => loadConfig(root)).toThrow(/not valid JSON/);
  });
});
