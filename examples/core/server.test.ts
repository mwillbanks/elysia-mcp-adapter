import { describe, expect, test } from 'bun:test'
import { jsonRequest, request } from './client.js'
import { app, cancellationObserved } from './server.js'

describe('modern core example', () => {
  test('runs MRTR, completion, pagination, progress, and subscriptions', async () => {
    const first = await jsonRequest(app, 'tools/call', {
      name: 'weather',
      arguments: { city: 'Chicago' }
    })
    expect(first.result.resultType).toBe('input_required')
    const retry = await jsonRequest(app, 'tools/call', {
      name: 'weather',
      arguments: { city: 'Chicago' },
      requestState: first.result.requestState,
      inputResponses: { location: { action: 'accept', content: { confirmed: true } } }
    })
    expect(retry.result.structuredContent.forecast).toBe('sunny')

    const completion = await jsonRequest(app, 'completion/complete', {
      ref: { type: 'ref/prompt', name: 'review' },
      argument: { name: 'file', value: 'adapter' }
    })
    expect(completion.result.completion.values).toEqual(['adapter.ts'])

    const page = await jsonRequest(app, 'tools/list')
    expect(page.result.tools).toHaveLength(2)
    expect(page.result.nextCursor).toBeString()
    const nextPage = await jsonRequest(app, 'tools/list', { cursor: page.result.nextCursor })
    expect(nextPage.result.tools).toHaveLength(1)

    const progress = await request(app, 'tools/call', {
      name: 'index',
      arguments: {},
      _meta: { progressToken: 'index-progress' }
    })
    expect(await progress.text()).toContain('notifications/progress')

    const cancellable = await request(app, 'tools/call', {
      name: 'wait-for-cancel',
      arguments: {},
      _meta: { progressToken: 'cancel-progress' }
    })
    const reader = cancellable.body?.getReader()
    if (!reader) throw new Error('Expected cancellable response stream')
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'Waiting for cancellation'
    )
    await reader.cancel()
    await Bun.sleep(0)
    expect(cancellationObserved).toBe(true)

    const subscription = await request(app, 'subscriptions/listen', {
      notifications: { toolsListChanged: true }
    })
    const stream = await subscription.text()
    expect(stream).toContain('notifications/subscriptions/acknowledged')
    expect(stream).toContain('notifications/tools/list_changed')
    expect(stream).toContain('notifications/cancelled')
  })
})
