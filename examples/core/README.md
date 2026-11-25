# Modern core example

## Elysia versions

The existing project runs with Elysia `1.4.32`. [Elysia 1 server](./server.ts) and [Elysia 2 server](../elysia-2/core/server.ts) show each route syntax.

Run the Elysia 1 project from the repository root:

```sh
bun run examples:setup
bun run build
bun run --cwd examples/core build
bun run --cwd examples/core typecheck
bun run --cwd examples/core test
bun run --cwd examples/core smoke
```

Run the same project with Elysia `2.0.0-rc.5`:

```sh
bun run examples:elysia2 -- core
```

The runner packs the adapter, stages shared sources with the Elysia 2 overlays in a temporary workspace,
and runs build, type checks, tests, and smoke checks. It removes the workspace after completion.
Use `--archive /absolute/path/adapter.tgz` to reuse an existing adapter archive.
See the [Elysia 2 examples guide](../elysia-2/README.md) for requirements and migration details.

This example uses the MCP `2026-07-28` HTTP envelope. It demonstrates synchronous MRTR,
signed continuation state, completion, pagination, private zero-TTL caching, progress SSE,
request cancellation, and change subscriptions.

The configured input budget permits at most 1,000 nested object members and array elements.
Oversized tool arguments fail before handler execution or task creation. Omit the option for unlimited input.
The MCP client SDK v2.4.0 interoperates with the modern envelope and parses the progress stream.
Adapter tests exercise Tasks, redirects, access-token renewal, and client error handling through that SDK.

SDK `2.4.0` rejects the modern `task` result discriminator after task creation succeeds, including
generic requests with a custom schema. Generic requests can read and cancel tasks. Use the minimal
Tasks example client for creation and avoid blindly retrying SDK failures that already created work.

Route handlers can use `getMcpInvocationContext(request)` to read the same MRTR, progress,
and cancellation context as explicit primitive handlers.

Run `bun run test` for the protocol client flow. Run `bun run smoke` for discovery and
completion checks. Production applications must load continuation and cursor signing keys
from secure configuration. A host remains responsible for approving elicitation, sampling,
roots access, and any action requested by a skill or tool.

Use Bun 1.4.4. Modern MCP uses per-request metadata and server/discover; legacy initialization remains supported. Route calls preserve Elysia handling and Origin checks.
