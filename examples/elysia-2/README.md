# Elysia 2 examples

The existing example projects remain the Elysia 1.4.32 sources. The Elysia 2 runner stages those projects
in an isolated temporary workspace, applies the source overlays here, and installs Elysia `2.0.0-rc.5`
with a packed adapter. Clients, providers, workers, UI assets, and tests remain shared.

Use Bun `>=1.4.4` and Node.js `>=22.18` when running Node consumers. The authorization examples require
OpenSSL. The Tasks smoke checks require Redis; configure the Redis connection as described in the
[Tasks README](../tasks/README.md).

Run one project from the repository root:

```sh
bun run examples:elysia2 -- core
```

Run all eight projects:

```sh
bun run examples:elysia2
```

Reuse an existing adapter package archive:

```sh
bun run examples:elysia2 -- core --archive /absolute/path/adapter.tgz
```

Each selected project runs its existing `build`, `typecheck`, `test`, and `smoke` commands. The runner
removes the temporary workspace after success or failure. It does not replace installed dependencies
or generated files in the original projects.

| Project                 | Shared source and Elysia 1 commands       | Elysia 2 source                                                        |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| Core                    | [Core](../core/README.md)                 | [Server overlay](./core/server.ts)                                     |
| Apps Vanilla            | [Vanilla](../apps-vanilla/README.md)      | [Shared server](../apps-vanilla/server.ts)                             |
| Apps React              | [React](../apps-react/README.md)          | [Shared server](../apps-react/server.ts)                               |
| Authorization           | [Authorization](../auth/README.md)        | [OAuth](../auth/oauth/app.ts), [enterprise](../auth/enterprise/app.ts) |
| Tasks                   | [Tasks](../tasks/README.md)               | [Worker overlay](./tasks/subprocess/worker.ts)                         |
| Skills                  | [Skills](../skills/README.md)             | [Shared server](../skills/server.ts)                                   |
| Events                  | [Events](../events/README.md)             | [Shared server](../events/server.ts)                                   |
| Experimental extensions | [Experimental](../experimental/README.md) | [Shared server](../experimental/server.ts)                             |

The overlays change routes with explicit options to the Elysia 2 hooks-first argument order:

```ts
// Elysia 1
app.get('/index', () => ({ ok: true }), { mcp: { name: 'index' } })

// Elysia 2
app.get('/index', { mcp: { name: 'index' } }, () => ({ ok: true }))
```

Two-argument routes and the adapter's fluent MCP registration methods use the same source on both
versions. Keep future changes in the shared projects and update overlays only when Elysia syntax differs.
