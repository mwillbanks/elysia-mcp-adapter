import { Elysia } from 'elysia'
import { MCP_INTERCEPTORS_LATEST_REVISION, mcp } from '@mwillbanks/elysia-mcp-adapter'

// This service hosts only interceptors. The invoking application remains a separate process.
const app = new Elysia()
  .use(
    mcp({
      allowedRoutes: [],
      extensions: { interceptors: { version: MCP_INTERCEPTORS_LATEST_REVISION } }
    })
  )
  .mcpInterceptor(
    {
      name: 'prefix-name',
      type: 'mutation',
      hooks: [{ events: ['tools/call'], phase: 'request' }],
      configSchema: {
        type: 'object',
        properties: { prefix: { type: 'string' } },
        required: ['prefix'],
        additionalProperties: false
      }
    },
    ({ payload, config, context }) => ({
      modified: true,
      payload: {
        name: `${config?.prefix ?? 'default:'}${String((payload as { name: string }).name).trim()}`
      },
      // Invocation metadata is supplied by the caller, not an authenticated identity.
      info: { callerContext: context ?? null }
    })
  )

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => app.handle(request)
})
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}/mcp`, pid: process.pid }))
process.on('SIGTERM', () => {
  server.stop(true)
  process.exit(0)
})
