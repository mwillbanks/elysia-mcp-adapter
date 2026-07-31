import { waitForCompletion } from '../shared/wait-for-completion.js'
import { BullMqTaskProvider } from './provider.js'

const provider = new BullMqTaskProvider()
try {
  const context = { version: '2026-07-28' as const, principalKey: 'smoke' }
  const task = await provider.create(
    {
      mode: 'required',
      execution: { method: 'tools/call', params: { name: 'smoke' } }
    },
    context,
    { invoke: async () => ({ ok: true }) }
  )
  await waitForCompletion(provider, task.taskId, context, 'BullMQ')
} finally {
  await provider[Symbol.asyncDispose]()
}
