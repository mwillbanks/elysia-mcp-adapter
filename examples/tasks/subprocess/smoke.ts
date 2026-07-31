import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForCompletion } from '../shared/wait-for-completion.js'
import { SqliteSubprocessTaskProvider } from './provider.js'

const directory = await mkdtemp(join(tmpdir(), 'elysia-tasks-smoke-'))
const provider = new SqliteSubprocessTaskProvider(join(directory, 'tasks.sqlite'))
try {
  const context = { version: '2026-07-28' as const, principalKey: 'smoke' }
  const task = await provider.create(
    {
      mode: 'required',
      execution: {
        method: 'tools/call',
        params: { name: 'tasks.run', arguments: { body: { value: 'ok', delayMs: 1 } } }
      }
    },
    context,
    { invoke: async () => ({}) }
  )
  await waitForCompletion(provider, task.taskId, context, 'Subprocess')
} finally {
  await provider[Symbol.asyncDispose]()
  await rm(directory, { recursive: true, force: true })
}
