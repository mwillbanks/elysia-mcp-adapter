import { type McpServerNotification, mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'

async function* changes(): AsyncGenerator<McpServerNotification> {
  yield { method: 'notifications/tools/list_changed' }
}

export let cancellationObserved = false

export const app = new Elysia()
  .use(
    mcp({
      allowedRoutes: [],
      server: { name: 'modern-core-example', version: '1.0.0' },
      core: {
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
      const location = context.inputResponses?.location
      if (!location) {
        return {
          resultType: 'input_required' as const,
          inputRequests: {
            location: {
              method: 'elicitation/create' as const,
              params: {
                mode: 'form' as const,
                message: `Confirm the location for ${city}`,
                requestedSchema: {
                  type: 'object',
                  properties: { confirmed: { type: 'boolean' } },
                  required: ['confirmed']
                }
              }
            }
          },
          requestState: city
        }
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
  .mcpTool('index', async (_input, context) => {
    context.reportProgress?.(1, { total: 2, message: 'Scanning' })
    await Promise.resolve()
    context.reportProgress?.(2, { total: 2, message: 'Complete' })
    return 'indexed'
  })
  .mcpTool('wait-for-cancel', async (_input, context) => {
    context.reportProgress?.(1, { message: 'Waiting for cancellation' })
    await new Promise<void>((resolve) => {
      context.signal?.addEventListener(
        'abort',
        () => {
          cancellationObserved = true
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
