#!/usr/bin/env bash
# Verify the PUBLISHED artifact, not the source tree.
#
# CI runs the test suite against src/, which cannot catch a packaging fault:
# a file missing from `files`, a broken bin path, a dist/ that fails to
# import, or a native dependency with no prebuild for the platform. Those
# faults appear only after `npm install` — that is, only to the user.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
npm run build >/dev/null
TARBALL="$(npm pack --silent | tail -1)"
mv "$TARBALL" "$WORK/pkg.tgz"

cd "$WORK"
npm init -y >/dev/null 2>&1
npm install ./pkg.tgz >/dev/null 2>&1
printf -- '---\ntitle: Smoke\nstatus: ok\n---\n\n# Smoke\n\nSearchable content here.\n' > note.md

echo "-> cli bin"
./node_modules/.bin/lore init >/dev/null
./node_modules/.bin/lore index | grep -q 'indexed:' || { echo "FAIL: index"; exit 1; }
./node_modules/.bin/lore search searchable | grep -q 'note.md' || { echo "FAIL: search"; exit 1; }
./node_modules/.bin/lore facts | grep -q 'status' || { echo "FAIL: facts"; exit 1; }

echo "-> library entrypoint + types"
node --input-type=module -e "
  import { existsSync } from 'node:fs';
  const m = await import('./node_modules/loreweave/dist/index.js');
  const need = ['openContext','indexVault','search','assertFact','queryFacts','dream','watchVault'];
  const missing = need.filter((n) => typeof m[n] !== 'function');
  if (missing.length) { console.error('FAIL: missing exports', missing); process.exit(1); }
  if (!existsSync('./node_modules/loreweave/dist/index.d.ts')) { console.error('FAIL: no types'); process.exit(1); }
"

echo "-> mcp server over stdio"
node --input-type=module -e "
  import { spawn } from 'node:child_process';
  const p = spawn('./node_modules/.bin/lore', ['serve','--mcp'], { stdio: ['pipe','pipe','pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'smoke',version:'1'}}}) + '\n');
  setTimeout(() => {
    p.kill();
    if (!out.includes('loreweave')) { console.error('FAIL: mcp did not initialize'); process.exit(1); }
    process.exit(0);
  }, 4000);
"
echo "package smoke test passed"
