# Modern core example

This example uses the MCP `2026-07-28` HTTP envelope. It demonstrates synchronous MRTR,
signed continuation state, completion, pagination, private zero-TTL caching, progress SSE,
request cancellation, and change subscriptions.

The configured input budget permits at most 1,000 nested object members and array elements.
Oversized tool arguments fail before handler execution or task creation. Omit the option for unlimited input.
The MCP client SDK v2.3 interoperates with the modern envelope and parses the progress stream.
Adapter tests exercise Tasks, redirects, access-token renewal, and client error handling through that SDK.

SDK `2.3.1` rejects the modern `task` result discriminator after task creation succeeds, including
generic requests with a custom schema. Generic requests can read and cancel tasks. Use the minimal
Tasks example client for creation and avoid blindly retrying SDK failures that already created work.

Route handlers can use `getMcpInvocationContext(request)` to read the same MRTR, progress,
and cancellation context as explicit primitive handlers.

Run `bun run test` for the protocol client flow. Run `bun run smoke` for discovery and
completion checks. Production applications must load continuation and cursor signing keys
from secure configuration. A host remains responsible for approving elicitation, sampling,
roots access, and any action requested by a skill or tool.
