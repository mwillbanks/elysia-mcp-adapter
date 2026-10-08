import { expect, test } from 'bun:test'
import { OriginBoundParentTransport } from '../examples/apps-vanilla/parent-transport.js'

test('Apps parent transport pins only a valid parent message and removes its listener', async () => {
  const sent: unknown[] = []
  const parent = { postMessage: (...args: unknown[]) => sent.push(args) }
  let listener: EventListener | undefined
  const surface = {
    parent,
    addEventListener: (_name: string, value: EventListener) => {
      listener = value
    },
    removeEventListener: (_name: string, value: EventListener) => {
      if (listener === value) listener = undefined
    }
  } as unknown as Pick<Window, 'parent' | 'addEventListener' | 'removeEventListener'>
  const transport = new OriginBoundParentTransport(surface)
  const received: unknown[] = []
  const errors: Error[] = []
  transport.onmessage = (message) => received.push(message)
  transport.onerror = (error) => errors.push(error)
  await expect(transport.send({ jsonrpc: '2.0', method: 'ping' })).rejects.toThrow('not started')
  await transport.start()
  await expect(transport.start()).rejects.toThrow('already started')
  const deliver = (source: unknown, origin: string, data: unknown) =>
    listener?.({ source, origin, data } as unknown as Event)
  deliver({}, 'https://attacker.test', { jsonrpc: '2.0', method: 'ping' })
  deliver(parent, 'https://invalid.test', {})
  expect(errors).toHaveLength(1)
  deliver(parent, 'https://host.test', { jsonrpc: '2.0', method: 'ping' })
  deliver(parent, 'https://attacker.test', { jsonrpc: '2.0', method: 'ping' })
  expect(received).toHaveLength(1)
  await transport.send({ jsonrpc: '2.0', method: 'ping' })
  expect(sent).toEqual([[{ jsonrpc: '2.0', method: 'ping' }, 'https://host.test']])
  await transport.close()
  expect(listener).toBeUndefined()
  await transport.close()
})
