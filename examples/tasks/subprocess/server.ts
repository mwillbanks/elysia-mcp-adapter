import { Elysia } from 'elysia'
import { mcp } from '../../../src/index.js'
import type { SqliteSubprocessTaskProvider } from './provider.js'

export function createSubprocessTaskApp(provider: SqliteSubprocessTaskProvider) {
  return new Elysia()
    .use(
      mcp({
        server: { name: 'subprocess-tasks', version: '1.0.0' },
        allowedRoutes: [],
        extensions: { tasks: { provider } }
      })
    )
    .mcpTool<{ body: { value: string; delayMs: number } }>(
      'tasks.run',
      () => {
        throw new Error('Subprocess tasks must execute in the fixed worker entrypoint')
      },
      {
        taskExecution: 'required',
        inputSchema: {
          type: 'object',
          properties: {
            body: {
              type: 'object',
              properties: {
                value: { type: 'string' },
                delayMs: { type: 'number', minimum: 0 }
              },
              required: ['value', 'delayMs'],
              additionalProperties: false
            }
          },
          required: ['body'],
          additionalProperties: false
        }
      }
    )
}
