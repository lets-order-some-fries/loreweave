import type { LoreContext } from '../context.js';

interface GraphDump {
  nodes: { id: string; label: string; type: 'note' | 'entity' }[];
  edges: { source: string; target: string; type: string; weight: number }[];
  /** What the dump left out, so a viewer is not read as the whole vault. */
  meta: { notes: number; entities: number; entitiesShown: number; minEntityUses: number };
}

/**
 * Note-level graph for visualization: notes, entities, and the links between
 * notes.
 *
 * The link edges are the point and were missing: the export carried only
 * note→entity mentions, so a vault's explicit `[[wiki links]]` — the structure
 * the whole design leans on — appeared nowhere, and opening the file in a
 * graph tool showed no connections between notes at all unless two happened to
 * share an entity.
 *
 * Entities are still filtered to those used at least twice, because a
 * once-mentioned entity is a leaf that clutters a picture without adding a
 * path. That filter is reported in `meta` rather than applied in silence.
 */
function dumpGraph(ctx: LoreContext): GraphDump {
  const db = ctx.store.db;
  const notes = db.prepare(`SELECT path, title FROM notes`).all() as {
    path: string;
    title: string;
  }[];
  const entities = db.prepare(
    `SELECT e.id, e.display, COUNT(m.id) AS uses FROM entities e
     JOIN mentions m ON m.entity_id = e.id GROUP BY e.id HAVING uses >= 2`,
  ).all() as { id: number; display: string; uses: number }[];
  const keep = new Set(entities.map((e) => e.id));
  const allEntities = (
    db.prepare(`SELECT COUNT(*) c FROM entities`).get() as { c: number }
  ).c;

  const nodes: GraphDump['nodes'] = [
    ...notes.map((n) => ({ id: `note:${n.path}`, label: n.title, type: 'note' as const })),
    ...entities.map((e) => ({ id: `entity:${e.id}`, label: e.display, type: 'entity' as const })),
  ];
  const edgeAgg = new Map<string, { source: string; target: string; type: string; weight: number }>();
  const mentions = db.prepare(
    `SELECT DISTINCT entity_id, note_path FROM mentions`,
  ).all() as { entity_id: number; note_path: string }[];
  for (const m of mentions) {
    if (!keep.has(m.entity_id)) continue;
    const k = `${m.note_path}→${m.entity_id}`;
    edgeAgg.set(k, {
      source: `note:${m.note_path}`,
      target: `entity:${m.entity_id}`,
      type: 'mentions',
      weight: 1,
    });
  }
  // Note → note, resolved the same way retrieval resolves them, so an
  // ambiguous name points at the same note in the picture and in the search.
  for (const [from, tos] of ctx.noteLinks().out) {
    for (const to of tos) {
      const k = `${from}⇢${to}`;
      if (edgeAgg.has(k)) continue;
      edgeAgg.set(k, {
        source: `note:${from}`,
        target: `note:${to}`,
        type: 'links',
        weight: 2,
      });
    }
  }
  return {
    nodes,
    edges: [...edgeAgg.values()],
    meta: {
      notes: notes.length,
      entities: allEntities,
      entitiesShown: entities.length,
      minEntityUses: 2,
    },
  };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function exportGraph(ctx: LoreContext, format: string): string {
  const g = dumpGraph(ctx);
  switch (format) {
    case 'json':
      return JSON.stringify(g, null, 2);
    case 'dot': {
      const lines = ['graph lore {', '  overlap=false;'];
      for (const n of g.nodes) {
        const shape = n.type === 'note' ? 'box' : 'ellipse';
        lines.push(`  "${n.id.replace(/"/g, "'")}" [label="${n.label.replace(/"/g, "'")}", shape=${shape}];`);
      }
      for (const e of g.edges) {
        lines.push(`  "${e.source.replace(/"/g, "'")}" -- "${e.target.replace(/"/g, "'")}";`);
      }
      lines.push('}');
      return lines.join('\n');
    }
    case 'graphml': {
      const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
        '<key id="label" for="node" attr.name="label" attr.type="string"/>',
        '<key id="type" for="node" attr.name="type" attr.type="string"/>',
        '<graph edgedefault="undirected">',
      ];
      for (const n of g.nodes) {
        lines.push(
          `<node id="${xmlEscape(n.id)}"><data key="label">${xmlEscape(n.label)}</data><data key="type">${n.type}</data></node>`,
        );
      }
      g.edges.forEach((e, i) => {
        lines.push(
          `<edge id="e${i}" source="${xmlEscape(e.source)}" target="${xmlEscape(e.target)}"/>`,
        );
      });
      lines.push('</graph>', '</graphml>');
      return lines.join('\n');
    }
    default:
      throw new Error(`unknown format: ${format} (use json|graphml|dot)`);
  }
}
