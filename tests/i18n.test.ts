import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { segmentCJK, hasCJK } from '../src/normalize.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { makeVault } from './helpers.js';

const VAULT = {
  'hindi.md': '---\ntitle: परियोजना नोट\n---\n\n# परियोजना नोट\n\nयह परियोजना मशीन लर्निंग के बारे में है। नेतृत्व [[प्रिया शर्मा]] करती हैं।\n',
  'priya.md': '---\ntitle: प्रिया शर्मा\n---\n\nप्रिया शर्मा भंडारण टीम का नेतृत्व करती हैं।\n',
  'chinese.md': '---\ntitle: 项目笔记\n---\n\n# 项目笔记\n\n这个项目关于机器学习。存储层使用列式布局。\n',
  'japanese.md': '---\ntitle: プロジェクトノート\n---\n\n# プロジェクトノート\n\nこのプロジェクトは機械学習に関するものです。\n',
  'french.md': "---\ntitle: Décisions d'architecture\n---\n\n# Décisions\n\nLe système utilise une mise en page en colonnes pour le stockage durable.\n",
  'english.md': '---\ntitle: Storage\n---\n\n# Storage\n\nThe ledger uses a columnar layout for durable storage.\n',
};

async function ctx(): Promise<LoreContext> {
  const root = await makeVault(VAULT);
  const config = ConfigSchema.parse({});
  const store = openStore(':memory:');
  await indexVault(store, root);
  let cached: LoreGraph | null = null;
  return {
    root, config, store, provider: null,
    graph: () => (cached ??= buildGraph(store, config)),
    noteLinks: () => buildNoteLinkGraph(store),
    invalidateGraph: () => (cached = null),
    close: () => store.close(),
  };
}

describe('segmentCJK', () => {
  it('splits CJK per character and leaves other scripts alone', () => {
    expect(segmentCJK('机器学习')).toBe('机 器 学 习');
    expect(segmentCJK('機械学習')).toBe('機 械 学 習');
    expect(segmentCJK('hello world')).toBe('hello world');
    expect(segmentCJK('मशीन लर्निंग')).toBe('मशीन लर्निंग');
    expect(segmentCJK('')).toBe('');
  });

  it('handles mixed scripts in one string', () => {
    expect(segmentCJK('the 项目 report')).toBe('the 项 目 report');
  });

  it('hasCJK identifies scripts needing segmentation', () => {
    expect(hasCJK('机器学习')).toBe(true);
    expect(hasCJK('プロジェクト')).toBe(true);
    expect(hasCJK('Décisions')).toBe(false);
    expect(hasCJK('मशीन')).toBe(false);
  });
});

describe('non-English vaults', () => {
  it('finds Chinese content — a whole sentence was one token before', async () => {
    const c = await ctx();
    const hits = await search(c, '机器学习', { k: 3, noLog: true });
    expect(hits.map((h) => h.notePath)).toContain('chinese.md');
    c.close();
  });

  it('finds Japanese content', async () => {
    const c = await ctx();
    const hits = await search(c, '機械学習', { k: 3, noLog: true });
    expect(hits.map((h) => h.notePath)).toContain('japanese.md');
    c.close();
  });

  it('finds Devanagari content and follows its wiki-links', async () => {
    const c = await ctx();
    const hits = await search(c, 'मशीन लर्निंग', { k: 3, noLog: true });
    expect(hits.map((h) => h.notePath)).toContain('hindi.md');
    const links = c.store.db.prepare('SELECT target FROM links').all() as { target: string }[];
    expect(links.some((l) => l.target.includes('प्रिया'))).toBe(true);
    c.close();
  });

  it('handles accented Latin script', async () => {
    const c = await ctx();
    const hits = await search(c, 'stockage durable', { k: 3, noLog: true });
    expect(hits[0]!.notePath).toBe('french.md');
    c.close();
  });

  it('English is unaffected by segmentation', async () => {
    const c = await ctx();
    const hits = await search(c, 'columnar layout durable storage', { k: 3, noLog: true });
    expect(hits[0]!.notePath).toBe('english.md');
    c.close();
  });
});
