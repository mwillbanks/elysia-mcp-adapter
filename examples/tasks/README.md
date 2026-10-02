# Durable Tasks examples

This independent Bun package demonstrates two production-shaped implementations of the adapter's
`TaskProvider` contract. Both store only the serial-safe execution descriptor and keep the injected
execution scheduler ephemeral.

Both providers persist MRTR request keys and partial responses, expose pending requests through
`input_required`, and reject lifetime key reuse. Unknown, answered, and superseded response keys
are acknowledged without changing stored responses. Recognized responses are validated against
their elicitation, sampling, or roots request. They intentionally stop there: the adapter's
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
state without keeping task callbacks in the database. Input, response, and cancellation changes use
immediate transactions and conditional nonterminal updates, so worker completion cannot be
overwritten or gain late input records.

`subprocess/server.ts` is the runnable application boundary. It installs the provider through the
Tasks extension and registers `tasks.run` as a required task tool. Its end-to-end test creates the
task with a modern `tools/call` request and polls `tasks/get` with request-scoped Tasks capability
metadata until the child-produced MCP result is complete.

## BullMQ + Redis

`bullmq/provider.ts` stores a task hash and execution descriptor in Redis and places only the task ID
on BullMQ. A real BullMQ `Worker` loads the durable descriptor before invoking the process-local
scheduler. Status changes are published for `listen`, while cancellation aborts active work or
removes a waiting job. Set `REDIS_URL` when Redis is not available at
`redis://127.0.0.1:6379`. The normal runtime uses BullMQ's supported `queue.add()` and Worker
processing paths, including stalled-job recovery. Each Worker atomically claims only a `working`
task, registers its cancellation controller before resolving a scheduler, and revalidates the claim
before invocation.

`bullmq/server.ts` installs the provider and registers its own required `tasks.run` tool. In this
variant the real Worker's processor invokes the ephemeral scheduler injected by that registration.
The end-to-end test proves the complete modern `tools/call` to `tasks/get` flow through `app.handle`.

Neither demo persists executable callbacks. The BullMQ provider accepts a trusted
`resolveScheduler` callback that reconstructs a scheduler from the persisted method descriptor and
provider context after restart. Register only application-owned dispatchers there; never treat
persisted parameters as code or credentials.

Run from the repository root so Bun links the examples to the checkout's built package:

```bash
bun run examples:setup
bun run build
bun run --cwd examples/tasks typecheck
bun run --cwd examples/tasks test
bun run --cwd examples/tasks smoke
```
