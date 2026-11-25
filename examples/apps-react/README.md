# React MCP App

## Elysia versions

The existing project runs with Elysia `1.4.32`. Both versions use the shared [server](./server.ts).

Run the Elysia 1 project from the repository root:

```sh
bun run examples:setup
bun run build
bun run --cwd examples/apps-react build
bun run --cwd examples/apps-react typecheck
bun run --cwd examples/apps-react test
bun run --cwd examples/apps-react smoke
```

Run the same project with Elysia `2.0.0-rc.5`:

```sh
bun run examples:elysia2 -- apps-react
```

The runner packs the adapter, stages shared sources with the Elysia 2 overlays in a temporary workspace,
and runs build, type checks, tests, and smoke checks. It removes the workspace after completion.
Use `--archive /absolute/path/adapter.tgz` to reuse an existing adapter archive.
See the [Elysia 2 examples guide](../elysia-2/README.md) for requirements and migration details.

This Bun, Elysia, React 19, and MCP Apps v2 example provides a responsive
task board, host-context handling, a model-visible launch tool, and an app-only mutation. The
checked-in shadcn-style source and Tailwind CSS compile into one standalone HTML file without
Vite, a CDN, or runtime asset fetches.

From the repository root, register the checkout and install all example workspaces first:

```bash
bun run examples:setup
```

Then run these commands from `examples/apps-react`:

```bash
bun run build
bun run smoke
bun run server.ts
```

The bounded host fixture in `../apps-host-fixture.ts` is protocol test infrastructure. Its tests
also connect the v2 `App` and `AppBridge` through SDK in-memory transports.

Use Bun 1.4.4. The reviewed Apps stable 2026-01-26 and draft contracts remain supported. Host approval, CSP, resource authorization, and UI permissions remain explicit.
