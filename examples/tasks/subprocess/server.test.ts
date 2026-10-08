import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitFor } from '../test-support.js'
import { SqliteSubprocessTaskProvider } from './provider.js'
import { createSubprocessTaskApp } from './server.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe('subprocess Tasks server', () => {
  test('creates and polls a required task through the modern MCP transport', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elysia-subprocess-server-'))
    const provider = new SqliteSubprocessTaskProvider(join(directory, 'tasks.sqlite'))
    cleanups.push(async () => {
      await provider[Symbol.asyncDispose]()
      await rm(directory, { recursive: true, force: true })
    })
    const app = createSubprocessTaskApp(provider)

    const created = await modernRpc(app, 'tools/call', {
      name: 'tasks.run',
      arguments: { body: { value: 'from-mcp', delayMs: 20 } }
    })
    expect(created.result.resultType).toBe('task')

    const completed = await pollTask(app, created.result.taskId as string)
    expect(completed.result).toMatchObject({
      resultType: 'complete',
      status: 'completed',
      result: { structuredContent: { value: 'from-mcp' } }
    })
  })
})

const tasksCapability = {
  extensions: { 'io.modelcontextprotocol/tasks': {} }
}

async function modernRpc(
  app: ReturnType<typeof createSubprocessTaskApp>,
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

async function pollTask(app: ReturnType<typeof createSubprocessTaskApp>, taskId: string) {
  return waitFor(`MCP task ${taskId} to finish`, async () => {
    const task = await modernRpc(app, 'tasks/get', { taskId })
    if (task.result.status !== 'working') return task
  })
}
