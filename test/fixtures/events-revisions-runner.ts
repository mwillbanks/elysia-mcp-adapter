import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { Elysia } from 'elysia'
import {
  subscribeEventsWebhook,
  type McpEventsRevision,
  type McpWebhookSubscriptionProvider,
  type McpWebhookSubscriptionRecord
} from '../../src/extensions/events/index.js'
import { normalizeOptions } from '../../src/options.js'
import { withMcpMethods } from '../../src/plugin.js'

const version = process.argv[2] as McpEventsRevision
const authorization = {
  principal: {
    tokenType: 'access_token' as const,
    subject: 'revision-owner',
    audience: 'mcp',
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    scopes: []
  },
  scopes: [],
  attributes: {}
}
const records = new Map<string, McpWebhookSubscriptionRecord>()
const codes: number[] = []
let delivered: (() => void) | undefined
let quota = false
const provider: McpWebhookSubscriptionProvider = {
  durability: 'durable',
  get: (key) => records.get(key) ?? null,
  upsert: (record) => {
    if (quota) return { limitExceeded: true }
    records.set(record.key, structuredClone(record))
    return { record: structuredClone(record), created: true }
  },
  delete: (key) => records.delete(key),
  list: async function* () {
    yield* records.values()
  },
  authorizeDelivery: () => authorization
}
const server = createServer(
  {
    key: readFileSync(new URL('./events-network/valid-key.pem', import.meta.url)),
    cert: readFileSync(new URL('./events-network/valid-cert.pem', import.meta.url))
  },
  async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const value = JSON.parse(body)
    if (value.type === 'verification') response.end(JSON.stringify({ challenge: value.challenge }))
    else {
      response.writeHead(202).end()
      if (value.type === 'terminated') {
        codes.push(value.error.code)
        delivered?.()
      }
    }
  }
)
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Missing listener')
const options = normalizeOptions({
  transport: { protocolVersions: ['2025-11-25'] },
  extensions: {
    events: {
      version,
      cursor: { signingKey: 'revision-webhook-signing-key-longer-than-32-bytes' },
      pollIntervalMs: 1,
      webhook: {
        provider,
        environment: 'development',
        allowPrivateAddresses: true,
        allowlist: () => true,
        resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
        maxAttempts: 1,
        requestTimeoutMs: 300
      }
    }
  }
})
let termination: number | undefined
const messages = [
  'NotFound',
  'Forbidden',
  'ResourceExhausted',
  'Unsupported',
  'CallbackEndpointError'
]
const app = new Elysia().use(withMcpMethods()).mcpEvent(
  {
    name: 'revision.webhook',
    description: 'Revision webhook',
    delivery: ['webhook'],
    inputSchema: { type: 'object' },
    payloadSchema: { type: 'object' }
  },
  () => ({
    events: [],
    cursor: null,
    ...(termination === undefined
      ? {}
      : { terminated: { code: -32011 - termination, message: messages[termination]! } })
  })
)
const context = {
  request: new Request('http://localhost/mcp'),
  protocolVersion: '2025-11-25' as const,
  authorization
}
const params = (path: string) => ({
  name: 'revision.webhook',
  arguments: {},
  cursor: null,
  delivery: {
    mode: 'webhook',
    url: `https://callback.test:${address.port}/${path}`,
    secret: `whsec_${Buffer.alloc(24, 4).toString('base64')}`
  }
})
const errorShape = (error: unknown) => {
  const value = error as { code: number; message: string; data: unknown }
  return { code: value.code, message: value.message, data: value.data }
}
try {
  for (let index = 0; index < messages.length; index++) {
    termination = undefined
    const received = new Promise<void>((resolve) => {
      delivered = resolve
    })
    await subscribeEventsWebhook(app, params(String(index)), options, context)
    termination = index
    await received
    // Await terminal cleanup before checking persisted state or creating the next subscription.
    while (records.size) await new Promise((resolve) => setTimeout(resolve, 1))
  }
  termination = undefined
  quota = true
  let quotaError: unknown
  try {
    await subscribeEventsWebhook(app, params('quota'), options, context)
  } catch (error) {
    quotaError = errorShape(error)
  }
  quota = false
  options.extensions.events!.webhook!.resolveAddresses = async () => {
    throw new Error('credential-bearing DNS failure')
  }
  let callbackError: unknown
  try {
    await subscribeEventsWebhook(app, params('callback'), options, context)
  } catch (error) {
    callbackError = errorShape(error)
  }
  console.log(
    JSON.stringify({ codes, quota: quotaError, callback: callbackError, records: records.size })
  )
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
