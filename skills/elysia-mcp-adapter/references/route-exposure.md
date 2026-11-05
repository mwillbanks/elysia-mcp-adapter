# Expose existing routes as MCP tools

Mount the adapter with an explicit list of routes the MCP client should see. Use the route's declared HTTP method and path template in the filter.

```ts
import { mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia, t } from 'elysia'

const app = new Elysia()
  .use(mcp({ allowedRoutes: [{ method: 'GET', path: '/users/:id' }] }))
  .get('/users/:id', ({ params }) => ({ id: params.id }), {
    params: t.Object({ id: t.String() }),
    detail: { operationId: 'users.get' },
    mcp: { annotations: { readOnlyHint: true } }
  })
```

- Use a stable, unique operation ID or explicit MCP name for a tool clients will retain. Set `mcp: false` on routes that must stay private. Use `allowedRoutes: []` for standalone-only registration.
- Inspect the advertised JSON Schema. Route arguments use the `params`, `query`, and `body` envelope where needed. Use flattened arguments only when fields are unambiguous and the advertised schema exposes them that way.
- Override the MCP schema for client-facing shape and description when needed. Keep Elysia validation aligned with the reconstructed HTTP request.
- Preserve route parsing, validation, guards, hooks, and error handling. The adapter invokes the route via `app.handle`. Put route access checks in that normal Elysia pipeline. Treat tool annotations as client hints.
- Verify `tools/list` exposes only the expected route tools. Invoke an allowed and a denied request through `tools/call` and check that route-level validation and authorization still apply.

See the [route-backed API reference](https://mwillbanks.github.io/elysia-mcp-adapter/docs/api-reference/route-backed-tools).
