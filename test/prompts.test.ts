import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { mcp } from '../src/index.js'
import { rpc } from './helpers.js'

const server = { name: 'test', version: '1.0.0' } as const

describe('prompts', () => {
  it('lists and gets explicit prompts', async () => {
    const app = new Elysia()
      .use(mcp({ server, allowedRoutes: [], transport: { validateOrigin: false } }))
      .mcpPrompt('debug-error', ({ status }: any) => `Debug HTTP ${status}`, {
        argsSchema: {
          type: 'object',
          properties: { status: { type: 'number' } },
          required: ['status'],
          additionalProperties: false
        }
      })

    const list = await rpc(app, 'prompts/list')
    expect(list.body.result.prompts[0]).toMatchObject({
      name: 'debug-error',
      arguments: [{ name: 'status', required: true }]
    })

    const get = await rpc(app, 'prompts/get', { name: 'debug-error', arguments: { status: 500 } })
    expect(get.body.result.messages[0].content.text).toBe('Debug HTTP 500')
  })

  it('exposes route-backed prompts with flat arguments derived from the body schema', async () => {
    const app = new Elysia().use(mcp({ server, transport: { validateOrigin: false } })).post(
      '/prompt',
      ({ body }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `diff=${body.diff}` } }]
      }),
      {
        body: t.Object({ diff: t.String() }),
        mcp: { kind: 'prompt', name: 'review' }
      }
    )

    const list = await rpc(app, 'prompts/list')
    expect(list.body.result.prompts[0]).toMatchObject({
      name: 'review',
      arguments: [{ name: 'diff', required: true }]
    })

    const get = await rpc(app, 'prompts/get', { name: 'review', arguments: { diff: 'X' } })
    expect(get.body.result.messages[0].content.text).toBe('diff=X')
  })

  it('rejects invalid prompt arguments', async () => {
    const app = new Elysia()
      .use(mcp({ server, allowedRoutes: [], transport: { validateOrigin: false } }))
      .mcpPrompt('debug-error', ({ status }: any) => `Debug ${status}`, {
        argsSchema: {
          type: 'object',
          properties: { status: { type: 'number' } },
          required: ['status'],
          additionalProperties: false
        }
      })

    const { body } = await rpc(app, 'prompts/get', { name: 'debug-error', arguments: {} })

    expect(body.error).toBeDefined()
  })
})
