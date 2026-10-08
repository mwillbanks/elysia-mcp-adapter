import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { mcp } from '../src/index.js'
import { rpc } from './helpers.js'

const server = { name: 'test', version: '1.0.0' } as const

describe('resources', () => {
  it('reads explicit static resources', async () => {
    const app = new Elysia()
      .use(mcp({ server, allowedRoutes: [], transport: { validateOrigin: false } }))
      .mcpResource('config://runtime', () => ({ nodeEnv: 'test' }), {
        name: 'runtime.config',
        mimeType: 'application/json'
      })

    const list = await rpc(app, 'resources/list')
    expect(list.body.result.resources[0]).toMatchObject({ uri: 'config://runtime' })

    const read = await rpc(app, 'resources/read', { uri: 'config://runtime' })
    expect(read.body.result.contents[0].text).toContain('nodeEnv')
  })

  it('reads explicit resource templates with URI variables', async () => {
    const app = new Elysia()
      .use(mcp({ server, allowedRoutes: [], transport: { validateOrigin: false } }))
      .mcpResource('users://{id}/profile', ({ variables }) => ({ id: variables.id }), {
        name: 'users.profile',
        mimeType: 'application/json'
      })

    const templates = await rpc(app, 'resources/templates/list')
    expect(templates.body.result.resourceTemplates[0].uriTemplate).toBe('users://{id}/profile')

    const read = await rpc(app, 'resources/read', { uri: 'users://u_1/profile' })
    expect(read.body.result.contents[0].text).toContain('u_1')
  })

  it('exposes routes as resources only when explicitly marked', async () => {
    const app = new Elysia()
      .use(mcp({ server, transport: { validateOrigin: false } }))
      .get('/docs/:slug', ({ params }) => ({ slug: params.slug, body: 'hello' }), {
        params: t.Object({ slug: t.String() }),
        mcp: {
          kind: 'resource',
          name: 'docs',
          resource: { uriTemplate: 'docs://{slug}', mimeType: 'application/json' }
        }
      })

    const tools = await rpc(app, 'tools/list')
    expect(tools.body.result.tools).toEqual([])

    const read = await rpc(app, 'resources/read', { uri: 'docs://intro' })
    expect(read.body.result.contents[0].uri).toBe('docs://intro')
    expect(read.body.result.contents[0].text).toContain('intro')
  })

  it('returns a JSON-RPC error for unknown resources', async () => {
    const app = new Elysia().use(
      mcp({ server, allowedRoutes: [], transport: { validateOrigin: false } })
    )

    const { body } = await rpc(app, 'resources/read', { uri: 'missing://x' })

    expect(body.error.code).toBe(-32002)
  })

  it('does not treat error resource bodies as input-required results', async () => {
    const app = new Elysia()
      .use(mcp({ server, transport: { validateOrigin: false } }))
      .get(
        '/private-doc',
        ({ status }) => status(403, { resultType: 'input_required', requestState: 'unsafe' }),
        {
          mcp: {
            kind: 'resource',
            name: 'private-doc',
            resource: { uri: 'docs://private', mimeType: 'application/json' }
          }
        }
      )

    const { body } = await rpc(app, 'resources/read', { uri: 'docs://private' })
    expect(body.error.code).toBe(-32603)
    expect(body.result).toBeUndefined()
  })
})
