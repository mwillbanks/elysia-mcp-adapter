# Experimental extensions

## Elysia versions

The existing project runs with Elysia `1.4.32`. Both versions use the shared [server](./server.ts) and [interceptor service](./interceptor-service.ts).

Run the Elysia 1 project from the repository root:

```sh
bun run examples:setup
bun run build
bun run --cwd examples/experimental build
bun run --cwd examples/experimental typecheck
bun run --cwd examples/experimental test
bun run --cwd examples/experimental smoke
```

Run the same project with Elysia `2.0.0-rc.5`:

```sh
bun run examples:elysia2 -- experimental
```

The runner packs the adapter, stages shared sources with the Elysia 2 overlays in a temporary workspace,
and runs build, type checks, tests, and smoke checks. It removes the workspace after completion.
Use `--archive /absolute/path/adapter.tgz` to reuse an existing adapter archive.
See the [Elysia 2 examples guide](../elysia-2/README.md) for requirements and migration details.

This Bun workspace exercises finalized Server Cards and opt-in experiments against the adapter itself:

- server-card discovery and conditional caching;
- interceptor discovery, invocation, sending and receiving order, isolated mutation and validation, audit failure outcomes, and local chaining;
- legacy server-variant discovery, selection, pagination limits, and principal-bound sessions;
- variant-bound resource subscriptions and teardown;
- action metadata and trust annotations, including absent versus `false` fields.

Run `bun --bun run test`, `bun --bun run smoke`, and `bun --bun run build` here. The clients call `app.handle(new Request(...))`, so every request uses the actual adapter transport. The separate interceptor service uses loopback HTTP in a child process. Other clients use in-process requests.

These experiments are disabled unless configured. Pin each revision shown in `server.ts` before production evaluation.

Use Bun 1.4.4. `interceptor-service.ts` hosts only interceptors. `remote-interceptor.ts` starts
that service, discovers it through HTTP, sends timestamp, trace, span, and session context,
and checks supplied configuration, omitted defaults, and invalid configuration rejection.
The child process terminates after each run. Local chain helpers are adapter utilities,
not remote-service orchestration. Principal claims in invocation context are untrusted.

Server Cards follow Final SEP-2127. Variants remain a legacy initialize experiment.
Action metadata and trust annotations remain experimental metadata, never authorization.
