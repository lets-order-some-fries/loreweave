# Security Policy

Loreweave is local-first: the CLI and MCP server operate on a markdown vault on your machine, and the index lives beside it. Anything that breaks that boundary is a security bug.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting: **Security tab → Report a vulnerability** on this repository. Include the loreweave version (`lore --version`), a reproduction, and the impact you see.

Reports we treat as highest priority:

- the CLI or MCP server reading files outside the vault it was pointed at
- vault content leaving the machine when no remote embedding provider was configured
- an MCP tool doing something its declared schema does not describe

## Not security bugs

Wrong search rankings, missed links, or facts superseding incorrectly are quality bugs — open a regular issue with the vault snippet that reproduces them.
