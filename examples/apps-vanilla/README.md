# Vanilla MCP App

## Elysia versions

The existing project runs with Elysia `1.4.32`. Both versions use the shared [server](./server.ts).

Run the Elysia 1 project from the repository root:

```sh
bun run examples:setup
bun run build
bun run --cwd examples/apps-vanilla build
bun run --cwd examples/apps-vanilla typecheck
bun run --cwd examples/apps-vanilla test
bun run --cwd examples/apps-vanilla smoke
```

Run the same project with Elysia `2.0.0-rc.5`:

```sh
bun run examples:elysia2 -- apps-vanilla
```

The runner packs the adapter, stages shared sources with the Elysia 2 overlays in a temporary workspace,
and runs build, type checks, tests, and smoke checks. It removes the workspace after completion.
Use `--archive /absolute/path/adapter.tgz` to reuse an existing adapter archive.
See the [Elysia 2 examples guide](../elysia-2/README.md) for requirements and migration details.

This Bun and Elysia example exposes a model-visible weather tool, an app-only refresh action,
and one self-contained `ui://` resource. It uses the MCP Apps v2 `App` API with the split client
peer and Zod v4. Its transport validates the parent window, pins the first valid origin, and applies
bounded request timeouts. Bun produces standalone HTML without Vite, CDNs, runtime assets, or
browser filesystem access.

From the repository root, register the checkout and install all example workspaces first:

```bash
bun run examples:setup
```

Then run these commands from `examples/apps-vanilla`:

```bash
bun run build
bun run smoke
bun run server.ts
```

The server imports the adapter from its public package root. Build the repository root before
running this example from a checkout.

Use Bun 1.4.4. The reviewed Apps stable 2026-01-26 and draft contracts remain supported. Host approval, CSP, resource authorization, and UI permissions remain explicit.
