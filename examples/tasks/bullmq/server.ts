import { mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'
import type { BullMqTaskProvider } from './provider.js'

export function createBullMqTaskApp(provider: BullMqTaskProvider) {
  return new Elysia()
    .use(
      mcp({
        server: { name: 'bullmq-tasks', version: '1.0.0' },
        allowedRoutes: [],
        extensions: { tasks: { provider } }
      })
    )
    .mcpTool<{ value: string; delayMs: number }>(
      'tasks.run',
      async ({ value, delayMs }) => {
        await Bun.sleep(delayMs)
        return { value, worker: 'bullmq' }
      },
      {
        taskExecution: 'required',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            delayMs: { type: 'number', minimum: 0 }
          },
          required: ['value', 'delayMs'],
          additionalProperties: false
        }
      }
    )
}
