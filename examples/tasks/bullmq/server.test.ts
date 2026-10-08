import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { type RedisFixture, startRedisFixture, waitFor } from '../test-support.js'
import { BullMqTaskProvider } from './provider.js'
import { createBullMqTaskApp } from './server.js'

const providers: BullMqTaskProvider[] = []
let redis: RedisFixture
beforeAll(async () => {
  redis = await startRedisFixture()
})
afterAll(async () => {
  await redis.close()
})
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider[Symbol.asyncDispose]()))
})

describe('BullMQ Tasks server', () => {
  test('runs the registered tool scheduler and polls it through modern MCP', async () => {
    const provider = new BullMqTaskProvider({ redisUrl: redis.url })
    providers.push(provider)
    const app = createBullMqTaskApp(provider)

    const created = await modernRpc(app, 'tools/call', {
      name: 'tasks.run',
      arguments: { value: 'from-mcp', delayMs: 20 }
    })
    expect(created.result.resultType).toBe('task')

    const completed = await pollTask(app, created.result.taskId as string)
    expect(completed.result).toMatchObject({
      resultType: 'complete',
      status: 'completed',
      result: { structuredContent: { value: 'from-mcp', worker: 'bullmq' } }
    })
  })
})

const tasksCapability = {
  extensions: { 'io.modelcontextprotocol/tasks': {} }
}

async function modernRpc(
  app: ReturnType<typeof createBullMqTaskApp>,
  method: 'tools/call' | 'tasks/get',
  params: Record<string, unknown>
) {
  const name = method === 'tools/call' ? params.name : params.taskId
  const response = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(typeof name === 'string' ? { 'mcp-name': name } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': tasksCapability
          }
        }
      })
    })
  )
  expect(response.status).toBe(200)
  return (await response.json()) as {
    result: Record<string, unknown> & { taskId?: string; status?: string }
  }
}

async function pollTask(app: ReturnType<typeof createBullMqTaskApp>, taskId: string) {
  return waitFor(`MCP task ${taskId} to finish`, async () => {
    const task = await modernRpc(app, 'tasks/get', { taskId })
    if (task.result.status !== 'working') return task
  })
}
