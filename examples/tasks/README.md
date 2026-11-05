# Durable Tasks examples

This independent Bun package demonstrates two production-shaped implementations of the adapter's
`TaskProvider` contract. Both store only the serial-safe execution descriptor and keep the injected
execution scheduler ephemeral.

Both providers persist task input keys and partial responses, expose pending requests through
`input_required`, and reject lifetime key reuse. Unknown, answered, and superseded keys leave
stored responses unchanged. The provider validates recognized answers against each request.
Resume work from an application-defined checkpoint to avoid repeating side effects. A zero TTL
permits the initial durable read, then expires the task and removes its scheduling state.

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

To pause for approval, set `arguments.body.requireApproval` to `true` in `tools/call` and declare
form elicitation. The worker binds `createMcpTaskExecutionContext` to the stored task and owner.
It records `notify.status('Waiting for approval')` and `input.request('approval', request)`, then
exits. Read the request and status with `tasks/get` or subscribe to task snapshots. Send the answer
under `tasks/update.params.inputResponses.approval`, for example
`{ "action": "accept", "content": { "approved": true } }`.

Once the final answer is stored, the provider starts another worker. That worker reads the stored
answer before calling the tool through Elysia. A provider reopened while the task waits can perform
the same resume. The integration test waits for each child to exit and exercises both processes.

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

CI supplies `TASKS_TEST_REDIS_URL` for its dedicated Redis service. The BullMQ tests use
unique queue names and leave the service running for the job. For local tests, the fixture starts
an isolated Redis instance on a dynamic loopback port. It uses a local `redis-server` executable
when available. On Linux without that executable, set `TASKS_TEST_REDIS_IMAGE` to an image already
present in Docker. The fixture uses `--pull=never`, host networking, and a unique container name,
then removes that exact container during cleanup.

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

Use Bun 1.4.4. Stable Tasks remains the default. Select `draft-b3d28ac` for the current draft. Migrate older `draft` and `draft-5246bc3` selectors to the approved revision or the current draft. Terminal tasks/get responses use resultType: "complete". Redis-backed checks require a real Redis service.
