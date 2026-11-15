# Installing with npm 12

npm 12 no longer runs a dependency's install script unless told to, and better-sqlite3 fetches its
binary in one: without `--allow-scripts=better-sqlite3` the install succeeds, but every command
that opens the index fails with "Could not locate the bindings file". npm 10 and 11, which Node
22, 24 and 26 ship with, need nothing, and accept the flag with `npm i -g` and `npx`.

- `npm i -g` and `npx` take the flag, as in [Quickstart](../README.md#quickstart) and the
  [MCP config](../README.md#use-it-as-agent-memory-mcp).
- npx keeps reusing an install it made without the flag, even once you add it: find that install
  with `npm cache npx ls` and remove it with `npm cache npx rm <key>`.
- In a project — your own, or a clone of this repository — npm 12 refuses the flag, and so does
  npm 11 from 11.16 on, which Node 24 and 26 ship with. npm 11 runs the script without it. On
  npm 12, approve the script instead with `npm approve-scripts better-sqlite3`, which records it
  under `allowScripts` in package.json, then run `npm rebuild better-sqlite3`.
