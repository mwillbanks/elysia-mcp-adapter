# Durable Tasks examples

This independent Bun package demonstrates two production-shaped implementations of the adapter's
`TaskProvider` contract. Both store only the serial-safe execution descriptor and keep the injected
execution scheduler ephemeral.

Both providers persist MRTR request keys and partial responses, expose pending requests through
`input_required`, and reject lifetime key reuse. They intentionally stop there: the adapter's
`TaskExecutionScheduler` accepts only an abort signal, so safely resuming application work requires
an application-defined checkpoint/continuation format that consumes the persisted responses. These
examples never replay an executor after input, because replay can duplicate side effects. A zero TTL
still permits the required initial durable read, then expires the record and removes any queued or
process-local scheduling state.

## Subprocess + SQLite

`subprocess/provider.ts` writes task state and ownership to SQLite before starting a fixed Bun worker
entrypoint. The child reconstructs an Elysia application using
`@mwillbanks/elysia-mcp-adapter`, sends the durable descriptor through the application's MCP endpoint
with `app.handle(new Request(...))`, and writes its result back to SQLite. Reads enforce TTL and
principal ownership. Cancellation terminates the child cooperatively, and `listen` polls durable
state without keeping task callbacks in the database.

`subprocess/server.ts` is the runnable application boundary. It installs the provider through the
Tasks extension and registers `tasks.run` as a required task tool. Its end-to-end test creates the
task with a modern `tools/call` request and polls `tasks/get` with request-scoped Tasks capability
metadata until the child-produced MCP result is complete.

## BullMQ + Redis

`bullmq/provider.ts` stores a task hash and execution descriptor in Redis and places only the task ID
on BullMQ. A real BullMQ `Worker` loads the durable descriptor before invoking the process-local
scheduler. Status changes are published for `listen`, while cancellation aborts active work or
removes a waiting job. The example uses `ioredis-mock`, so it runs without an external Redis service.
Because the mock does not implement BullMQ's `cmsgpack` Lua enqueue/fetch primitives, the
mock-compatible queue stores task IDs in a Redis list and dispatches a genuine BullMQ `Job` directly
through the real Worker's processor hook. With Redis, replace that small compatibility shim with
`queue.add()` and `worker.run()`; the durable task hashes and processor stay unchanged.

`bullmq/server.ts` installs the provider and registers its own required `tasks.run` tool. In this
variant the real Worker's processor invokes the ephemeral scheduler injected by that registration.
The end-to-end test proves the complete modern `tools/call` to `tasks/get` flow through `app.handle`.

Neither demo persists the scheduler. A deployment that allows producers and consumers to run in
different processes should replace that callback with a worker-side descriptor dispatcher like the
subprocess example.

Run from the repository root so Bun links the examples to the checkout's built package:

```bash
bun run examples:setup
bun run build
bun run --cwd examples/tasks typecheck
bun run --cwd examples/tasks test
bun run --cwd examples/tasks smoke
```
