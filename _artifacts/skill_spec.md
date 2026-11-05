# Adapter skill scope

Use a single integration skill to route readers to one of four references.
The skill covers existing routes, standalone primitives, transport and
authorization, and extension version selection. The references combine public
configuration with checks consumers can perform against their mounted endpoint.

The README and website pages listed in the skill frontmatter are canonical.
Review the relevant reference when a mapped page changes. Update the
frontmatter and tree when a mapped page moves or when another page replaces it.
When the existing guidance still applies, record the evidence and the reason
through Intent's maintainer review.

Use the installed Intent 0.5.6 CLI from the package root. Run
`node node_modules/@tanstack/intent/dist/cli.mjs maintainer review --json`
and inspect the pending items. Keep the resolved outcomes in
`.intent/review-state.json` with the reviewed changes. CI runs
`bun run intent:check`.
Use `node node_modules/@tanstack/intent/dist/cli.mjs stale skills` to inspect
version drift. Compare the mapped source and guidance before deciding whether
a release requires an update.

Keep application-specific identity policy, raw MCP protocol documentation,
and serving Skills over MCP in their respective documentation. Ship the
guidance and its references with the npm package. Keep these planning records
and source-review state in the repository.
