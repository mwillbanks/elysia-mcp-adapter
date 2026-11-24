# Skills over MCP example

## Elysia versions

The existing project runs with Elysia `1.4.32`. Both versions use the shared [server](./server.ts).

Run the Elysia 1 project from the repository root:

```sh
bun run examples:setup
bun run build
bun run --cwd examples/skills build
bun run --cwd examples/skills typecheck
bun run --cwd examples/skills test
bun run --cwd examples/skills smoke
```

Run the same project with Elysia `2.0.0-rc.5`:

```sh
bun run examples:elysia2 -- skills
```

The runner packs the adapter, stages shared sources with the Elysia 2 overlays in a temporary workspace,
and runs build, type checks, tests, and smoke checks. It removes the workspace after completion.
Use `--archive /absolute/path/adapter.tgz` to reuse an existing adapter archive.
See the [Elysia 2 examples guide](../elysia-2/README.md) for requirements and migration details.

This Bun example registers exact `SKILL.md` and supporting-file bytes with `.mcpSkill()`.
The client pages `skills/list`, performs a direct `skills/get`, reads each resource, and verifies
its byte size and SHA-256 digest before use. The fixture includes a zero-byte text resource to
verify that empty `text` content remains distinct from binary `blob` content.

Run it with:

```bash
bun run test
bun run smoke
```

The adapter serves skill content as untrusted data. A host must identify the source server,
obtain per-skill approval, bind approval to the complete manifest, verify every read, and gate
all local execution and permission grants. The adapter never executes a skill or resolves its
URI through DNS or the local filesystem.

Use Bun 1.4.4. The current stable Skills revision preserves optional skill `_meta`. This example checks metadata in both discovery and lookup while independently verifying exact resource digests. It enables directory reads explicitly and never executes published skills.
