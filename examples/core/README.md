# Modern core example

This example uses the MCP `2026-07-28` HTTP envelope. It demonstrates synchronous MRTR,
signed continuation state, completion, pagination, private zero-TTL caching, progress SSE,
request cancellation, and change subscriptions.

Route handlers can use `getMcpInvocationContext(request)` to read the same MRTR, progress,
and cancellation context as explicit primitive handlers.

Run `bun run test` for the protocol client flow. Run `bun run smoke` for discovery and
completion checks. Production applications must load continuation and cursor signing keys
from secure configuration. A host remains responsible for approving elicitation, sampling,
roots access, and any action requested by a skill or tool.
