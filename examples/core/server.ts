import {
  type McpServerNotification,
  getMcpInvocationContext,
  mcp,
  mcpInput
} from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'

async function* changes(): AsyncGenerator<McpServerNotification> {
  yield { method: 'notifications/tools/list_changed' }
}

export let cancellationObserved = false
let resolveCancellation = () => {}
export const cancellationDone = new Promise<void>((resolve) => {
  resolveCancellation = resolve
})

export const app = new Elysia()
  .use(
    mcp({
      allowedRoutes: ['/index'],
      server: { name: 'modern-core-example', version: '1.0.0' },
      core: {
        maxToolInputElements: 1_000,
        logging: true,
        continuation: {
          // Load a secret of at least 32 bytes from secure application configuration in production.
          signingKey: '0123456789abcdef0123456789abcdef'
        },
        pagination: {
          pageSize: 2,
          signingKey: '0123456789abcdef0123456789abcdef'
        },
        cache: { default: { cacheScope: 'private', ttlMs: 0 } },
        subscriptions: {
          provider: { subscribe: () => changes() },
          toolsListChanged: true
        }
      }
    })
  )
  .mcpTool(
    'weather',
    ({ city }: { city: string }, context) => {
      const form = mcpInput.form({
        message: `Confirm the location for ${city}`,
        requestedSchema: {
          type: 'object',
          properties: { confirmed: { type: 'boolean' } },
          required: ['confirmed']
        }
      })
      if (!context.input.supports(form)) return { city, forecast: 'sunny' }
      const location = context.input.response('location', form)
      if (!location) return context.input.require({ location: form }, { state: city })
      if (location.action !== 'accept' || location.content?.confirmed !== true) {
        return { city, confirmed: false }
      }
      return { city: context.requestState, forecast: 'sunny', location }
    },
    {
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false
      }
    }
  )
  .get(
    '/index',
    ({ request }) => {
      const notify = getMcpInvocationContext(request)?.notify
      notify?.progress(1, { total: 2, message: 'Scanning' })
      notify?.message('Index scan complete', { logger: 'indexer' })
      notify?.progress(2, { total: 2, message: 'Complete' })
      return new Response('indexed', { headers: { 'content-type': 'text/plain' } })
    },
    { mcp: { name: 'index' } }
  )
  .mcpTool('wait-for-cancel', async (_input, context) => {
    context.notify.progress(1, { message: 'Waiting for cancellation' })
    await new Promise<void>((resolve) => {
      context.signal?.addEventListener(
        'abort',
        () => {
          cancellationObserved = true
          resolveCancellation()
          resolve()
        },
        { once: true }
      )
    })
    return 'cancelled'
  })
  .mcpPrompt('review', ({ file }: { file: string }) => `Review ${file}`, {
    complete: ({ argument }) => ({ values: [`${argument.value}.ts`] })
  })
  .mcpResource('docs:///{name}', ({ variables }) => `# ${variables.name}`, {
    complete: ({ argument }) => ({ values: [`${argument.value}.md`] })
  })
