# Register standalone MCP primitives

Use standalone registration for behavior without an HTTP route. Mount `mcp()` before using the registration methods. Use `allowedRoutes: []` when the endpoint should expose only standalone registrations.

```ts
import { mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'

const app = new Elysia().use(mcp({ allowedRoutes: [] }))

app.mcpTool('math.add', ({ a, b }: { a: number; b: number }) => a + b, {
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b']
  }
})
app.mcpResource('config://runtime', () => ({ environment: 'production' }))
app.mcpPrompt('review-error', ({ message }: { message: string }) => [
  { role: 'user', content: { type: 'text', text: `Review this error: ${message}` } }
])
```

- Use a tool for an operation with typed arguments. Supply a matching JSON Schema and constrain or validate inputs at the handler boundary.
- Use a resource for readable data identified by a URI. Use a resource template when URI variables select a resource. Validate those variables and authorize the selected record before reading it.
- Use a prompt to return messages assembled from arguments. Keep side effects in explicit operations.
- Enforce authorization at the MCP endpoint or in the standalone handler as appropriate. Standalone handlers have no backing route whose guards can enforce record-level access.
- Verify each primitive appears in its expected list, then call, read, or get it through the MCP endpoint. Include a denial test for any protected data or operation.

See the [standalone API reference](https://mwillbanks.github.io/elysia-mcp-adapter/docs/api-reference/standalone-primitives).
