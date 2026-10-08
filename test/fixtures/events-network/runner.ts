import { readFileSync } from 'node:fs'
import https, { createServer } from 'node:https'
import { createServer as createTcpServer } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { type McpWebhookHttpResponse, postWebhook } from '../../../src/extensions/events/network.js'

const mode = process.argv[2] ?? 'success'
const family = process.argv[3] === 'ipv6' ? 6 : 4
const host = family === 6 ? '::1' : '127.0.0.1'
const certificate = mode === 'invalid-san' || mode === 'ambient-insecure' ? 'invalid-san' : 'valid'
let observed: Record<string, unknown> = {}
let markReceived: (() => void) | undefined
const received = new Promise<void>((resolve) => {
  markReceived = resolve
})
let markClosed: (() => void) | undefined
const socketClosed = new Promise<void>((resolve) => {
  markClosed = resolve
})
let proxyConnections = 0
const proxy = createTcpServer((socket) => {
  proxyConnections += 1
  socket.destroy()
})
await new Promise<void>((resolve, reject) => {
  proxy.once('error', reject)
  proxy.listen(0, '127.0.0.1', resolve)
})
const proxyAddress = proxy.address()
if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing proxy address')
const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`
const proxyEnv = {
  HTTP_PROXY: proxyUrl,
  HTTPS_PROXY: proxyUrl,
  ALL_PROXY: proxyUrl,
  NO_PROXY: ''
}
Object.assign(process.env, proxyEnv)
const originalAgent = https.globalAgent
type ProxyAgentOptions = NonNullable<ConstructorParameters<typeof https.Agent>[0]> & {
  proxyEnv: Readonly<Record<string, string>>
}
https.globalAgent = new https.Agent({ proxyEnv } as ProxyAgentOptions)
await new Promise<void>((resolve) => {
  const control = https.request({ hostname: 'callback.test', port: 443, method: 'POST' }, () =>
    resolve()
  )
  control.once('error', () => resolve())
  control.end()
})
const proxyControlConnections = proxyConnections
const server = createServer({
  key: readFileSync(new URL(`${certificate}-key.pem`, import.meta.url)),
  cert: readFileSync(new URL(`${certificate}-cert.pem`, import.meta.url))
})
server.on('request', (request, response) => {
  markReceived?.()
  request.socket.once('close', () => markClosed?.())
  observed = {
    host: request.headers.host,
    servername: (request.socket as TLSSocket).servername,
    remoteAddress: request.socket.remoteAddress,
    method: request.method,
    url: request.url
  }
  if (mode === 'oversize') {
    response.end('x'.repeat(128))
    return
  }
  if (mode === 'early-close') {
    response.writeHead(200, { 'content-length': '20' })
    response.write('short')
    response.socket?.destroy()
    return
  }
  if (mode === 'redirect') {
    response.writeHead(302, { location: 'https://example.invalid/elsewhere' })
    response.end('redirect')
    return
  }
  if (mode === 'active-abort' || mode === 'active-timeout') return
  response.writeHead(202)
  response.end('accepted')
})
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, host, resolve)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Missing listener address')
try {
  let resolvedCalls = 0
  let response: McpWebhookHttpResponse | undefined
  const controller = new AbortController()
  const deliveries = mode === 'fresh-dns' ? 2 : 1
  for (let delivery = 0; delivery < deliveries; delivery += 1) {
    const pending = postWebhook(
      new URL(`https://callback.test:${address.port}/hook?source=test`),
      new TextEncoder().encode('payload'),
      { 'content-type': 'application/json' },
      {
        allowPrivateAddresses: true,
        resolveAddresses: async () => {
          resolvedCalls += 1
          return [{ address: host, family }]
        },
        requestTimeoutMs: mode === 'active-timeout' ? 40 : 500,
        maxResponseBytes: mode === 'oversize' ? 16 : 1024
      },
      controller.signal
    )
    if (mode === 'active-abort') {
      await received
      controller.abort('fixture cancellation')
    }
    response = await pending
  }
  console.log(
    JSON.stringify({
      ok: true,
      status: response?.status,
      body: response ? new TextDecoder().decode(response.body) : undefined,
      observed,
      resolvedCalls,
      proxyControlConnections,
      productionProxyConnections: proxyConnections - proxyControlConnections
    })
  )
} catch (error) {
  const reason = typeof error === 'object' && error && 'reason' in error ? error.reason : undefined
  if (mode === 'active-abort' || mode === 'active-timeout') await socketClosed
  console.log(JSON.stringify({ ok: false, reason, observed }))
} finally {
  https.globalAgent = originalAgent
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => proxy.close(() => resolve()))
}
