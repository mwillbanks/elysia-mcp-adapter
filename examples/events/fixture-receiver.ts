import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:https'
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
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const result = verifier.verify(
      body,
      new Headers(request.headers as Record<string, string>),
      secrets
    )
    let challenge: { challenge: string } | null = null
    if (result.accepted) {
      try {
        challenge = challengeResponse(body)
      } catch {}
      appendFileSync(
        logPath,
        `${JSON.stringify({ kind: challenge ? 'challenge' : 'event', duplicate: result.duplicate, signature: request.headers['webhook-signature'] })}\n`
      )
    }
    response.writeHead(result.accepted ? 200 : 401, { 'content-type': 'application/json' })
    response.end(JSON.stringify(challenge ?? { accepted: result.accepted }))
  }
)
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Missing receiver address')
console.log(address.port)
const close = async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  process.exit(0)
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
