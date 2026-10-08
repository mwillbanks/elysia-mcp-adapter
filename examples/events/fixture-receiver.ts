import { appendFileSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { createServer } from 'node:https'
import { listenLoopbackTls } from './listen-fixture.js'
import { challengeResponse, StandardWebhookReceiver } from './receiver.js'

const logPath = process.argv[2]
if (!logPath) throw new Error('Expected receiver log path')
const secrets = ['whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB', 'whsec_AgICAgICAgICAgICAgICAgICAgICAgIC']
const verifier = new StandardWebhookReceiver()
const server = createServer(
  {
    key: readFileSync(new URL('./fixtures/valid-key.pem', import.meta.url)),
    cert: readFileSync(new URL('./fixtures/valid-cert.pem', import.meta.url))
  },
  async (request, response) => {
    const body = await requestBytes(request)
    const result = verifier.verify(
      body,
      new Headers(request.headers as Record<string, string>),
      secrets
    )
    const challenge = result.accepted
      ? recordDelivery(logPath, body, result.duplicate, request.headers['webhook-signature'])
      : null
    response.writeHead(result.accepted ? 200 : 401, { 'content-type': 'application/json' })
    response.end(JSON.stringify(challenge ?? { accepted: result.accepted }))
  }
)

async function requestBytes(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function recordDelivery(
  path: string,
  body: Uint8Array,
  duplicate: boolean,
  signature: unknown
): { challenge: string } | null {
  let challenge: { challenge: string } | null = null
  try {
    challenge = challengeResponse(body)
  } catch {}
  appendFileSync(
    path,
    `${JSON.stringify({ kind: challenge ? 'challenge' : 'event', duplicate, signature })}\n`
  )
  return challenge
}
const port = await listenLoopbackTls(server)
console.log(port)
const close = async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  process.exit(0)
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
