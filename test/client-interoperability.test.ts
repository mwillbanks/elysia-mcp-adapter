import { describe, expect, test } from 'bun:test'
import {
  Client,
  type FetchLike,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'
import { Elysia } from 'elysia'
import { z } from 'zod'
import {
  type DetailedTask,
  mcp,
  type TaskDurableCreateRequest,
  type TaskExecutionScheduler,
  type TaskInputResponses,
  type TaskProvider,
  type TaskProviderContext
} from '../src/index.js'

const server = { name: 'sdk-interoperability', version: '1.0.0' }
const endpoint = new URL('https://mcp.example.test/mcp')
const publishedModernCreateTaskResult = z.object({
  resultType: z.literal('task'),
  taskId: z.string(),
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  ttlMs: z.number(),
  pollIntervalMs: z.number().optional()
})

function appFetch(app: Elysia): FetchLike {
  return async (input, init) => app.handle(new Request(input, init))
}

function modernClient(capabilities: Record<string, unknown> = {}) {
  return new Client(
    { name: 'sdk-2.3-client', version: '1.0.0' },
    { capabilities, versionNegotiation: { mode: { pin: '2026-07-28' } } }
  )
}

async function connectClient(
  app: Elysia,
  options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {},
  capabilities: Record<string, unknown> = {}
) {
  const client = modernClient(capabilities)
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: appFetch(app),
    ...options
  })
  await client.connect(transport)
  return { client, transport }
}

describe('MCP client 2.3.1 interoperability', () => {
  test('negotiates modern discovery, lists tools, parses SSE progress, and normalizes prompt arguments', async () => {
    const progress: number[] = []
    let promptArguments: Record<string, unknown> | undefined
    const app = new Elysia()
      .use(mcp({ server, allowedRoutes: [] }))
      .mcpTool('work', (_input, context) => {
        context.reportProgress?.(1, { total: 2 })
        context.reportProgress?.(2, { total: 2 })
        return { complete: true }
      })
      .mcpPrompt('empty', (args) => {
        promptArguments = args
        return 'empty arguments accepted'
      })
    const { client } = await connectClient(app)

    try {
      expect(client.getProtocolEra()).toBe('modern')
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('work')
      const result = await client.callTool(
        { name: 'work', arguments: {} },
        { onprogress: (notification) => progress.push(notification.progress) }
      )
      const prompt = await client.getPrompt({ name: 'empty' })

      expect(result.structuredContent).toEqual({ complete: true })
      expect(progress).toEqual([1, 2])
      expect(prompt.messages[0]?.content).toMatchObject({ text: 'empty arguments accepted' })
      expect(promptArguments).toEqual({})
    } finally {
      await client.close()
    }
  })

  test('renews authentication once and rejects tokens with the wrong audience', async () => {
    let token = 'expired'
    let renewals = 0
    const app = new Elysia()
      .use(
        mcp({
          server,
          allowedRoutes: [],
          extensions: {
            auth: {
              resource: endpoint.href,
              authorizationServers: ['https://auth.example.test'],
              verifyAccessToken: async (value) => ({
                tokenType: 'access_token',
                subject: 'client',
                issuer: 'https://auth.example.test',
                audience: value === 'renewed' ? endpoint.href : 'https://wrong.example.test/mcp',
                scopes: [],
                expiresAt: Math.floor(Date.now() / 1000) + 60
              })
            }
          }
        })
      )
      .mcpTool('authorized', () => 'ok')
    const client = modernClient()
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: appFetch(app),
      authProvider: {
        token: async () => token,
        onUnauthorized: async () => {
          renewals += 1
          token = 'renewed'
        }
      }
    })

    await client.connect(transport)
    try {
      expect(renewals).toBe(1)
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['authorized'])
    } finally {
      await client.close()
    }
  })

  test('follows same-origin redirects and refuses cross-origin redirects before contact', async () => {
    const app = new Elysia()
      .use(mcp({ server, allowedRoutes: [] }))
      .mcpTool('redirected', () => 'ok')
    let sameOriginTargetRequests = 0
    const sameOriginFetch: FetchLike = async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname === '/mcp') {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://mcp.example.test/redirected' }
        })
      }
      sameOriginTargetRequests += 1
      return app.handle(new Request(endpoint, init))
    }
    const sameOriginClient = modernClient()
    await sameOriginClient.connect(
      new StreamableHTTPClientTransport(endpoint, { fetch: sameOriginFetch })
    )
    try {
      expect((await sameOriginClient.listTools()).tools[0]?.name).toBe('redirected')
      expect(sameOriginTargetRequests).toBeGreaterThan(0)
    } finally {
      await sameOriginClient.close()
    }

    let crossOriginContacts = 0
    let redirectRequests = false
    const crossOriginFetch: FetchLike = async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).origin === 'https://other.example.test') {
        crossOriginContacts += 1
        return app.handle(request)
      }
      if (!redirectRequests) return app.handle(request)
      return new Response(null, {
        status: 307,
        headers: { location: 'https://other.example.test/mcp' }
      })
    }
    const crossOriginClient = modernClient()
    await crossOriginClient.connect(
      new StreamableHTTPClientTransport(endpoint, { fetch: crossOriginFetch })
    )
    try {
      redirectRequests = true
      await expect(crossOriginClient.listTools()).rejects.toBeInstanceOf(SdkHttpError)
      expect(crossOriginContacts).toBe(0)
    } finally {
      await crossOriginClient.close()
    }
  })

  test('surfaces the SDK task-result gap while reading and cancelling modern tasks', async () => {
    const provider = new ClientTaskProvider()
    const app = new Elysia()
      .use(mcp({ server, allowedRoutes: [], extensions: { tasks: { provider } } }))
      .mcpTool('queued', () => ({ complete: true }), { taskExecution: 'required' })
    const capabilities = { extensions: { 'io.modelcontextprotocol/tasks': {} } }
    const { client } = await connectClient(app, {}, capabilities)

    try {
      await expect(
        client.request(
          { method: 'tools/call', params: { name: 'queued', arguments: {} } },
          publishedModernCreateTaskResult
        )
      ).rejects.toMatchObject({
        code: SdkErrorCode.UnsupportedResultType,
        data: { method: 'tools/call', resultType: 'task' }
      })
      await expect(client.callTool({ name: 'queued', arguments: {} })).rejects.toMatchObject({
        code: SdkErrorCode.UnsupportedResultType,
        data: { method: 'tools/call', resultType: 'task' }
      })
      const taskId = provider.lastCreatedTaskId
      if (!taskId) throw new Error('Expected the adapter to create a task')
      const read = await client.request(
        { method: 'tasks/get', params: { taskId } },
        z.object({ taskId: z.string(), status: z.literal('working') })
      )
      const cancelled = await client.request(
        { method: 'tasks/cancel', params: { taskId } },
        z.object({})
      )

      expect(read).toMatchObject({ taskId, status: 'working' })
      expect(cancelled).toEqual({})
      expect(provider.createdTaskIds).toHaveLength(2)
      expect((await provider.get(taskId, {} as TaskProviderContext))?.status).toBe('cancelled')
    } finally {
      await client.close()
    }
  })
})

class ClientTaskProvider implements TaskProvider {
  private readonly tasks = new Map<string, DetailedTask>()
  readonly createdTaskIds: string[] = []
  lastCreatedTaskId?: string

  async create(
    _request: TaskDurableCreateRequest,
    _context: TaskProviderContext,
    _scheduler: TaskExecutionScheduler
  ) {
    const timestamp = new Date().toISOString()
    const task: DetailedTask = {
      taskId: crypto.randomUUID(),
      status: 'working',
      createdAt: timestamp,
      lastUpdatedAt: timestamp,
      ttlMs: 60_000,
      pollIntervalMs: 10
    }
    this.tasks.set(task.taskId, task)
    this.createdTaskIds.push(task.taskId)
    this.lastCreatedTaskId = task.taskId
    return task
  }

  async get(taskId: string, _context: TaskProviderContext) {
    return this.tasks.get(taskId)
  }

  async update(_taskId: string, _responses: TaskInputResponses) {
    return true
  }

  async requestInput() {
    return true
  }

  async cancel(taskId: string) {
    const task = this.tasks.get(taskId)
    if (!task) return false
    this.tasks.set(taskId, {
      ...task,
      status: 'cancelled',
      lastUpdatedAt: new Date().toISOString()
    })
    return true
  }
}
