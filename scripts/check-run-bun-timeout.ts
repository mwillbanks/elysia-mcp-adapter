import assert from 'node:assert/strict'
import { runBun } from './run-bun.js'

function isPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535
}

const timeoutMs = 2500
const token = crypto.randomUUID()
const ready = Promise.withResolvers<string>()
const control = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    const port = Number(url.searchParams.get('port'))
    if (url.pathname !== `/${token}` || !isPort(port)) {
      return new Response(null, { status: 400 })
    }
    ready.resolve(`http://127.0.0.1:${port}/${token}`)
    return new Response(null, { status: 204 })
  }
})

const fixture = `
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== '/' + ${JSON.stringify(token)}) {
      return new Response(null, { status: 404 })
    }
    if (request.method === 'POST') {
      clearTimeout(watchdog)
      server.stop()
    }
    return new Response(${JSON.stringify(token)})
  }
})
const watchdog = setTimeout(() => server.stop(true), 10000)
await fetch(${JSON.stringify(new URL(token, control.url).href)} + '?port=' + server.port)
`
const command = `
const fixture = Bun.spawn([process.execPath, '-e', ${JSON.stringify(fixture)}], {
  stdout: 'inherit', stderr: 'inherit'
})
process.exit(await fixture.exited)
`

const outcome = runBun(['-e', command], process.cwd(), process.execPath, timeoutMs).then(
  () => null,
  (error: unknown) => error
)
const deadline = Promise.withResolvers<never>()
const watchdog = setTimeout(
  () => deadline.reject(new Error('Timed-out command did not settle')),
  2 * timeoutMs
)
let fixtureUrl: string | undefined

try {
  const liveUrl = await Promise.race([
    ready.promise,
    outcome.then((error) => {
      throw new Error('Command stopped before the fixture was ready', { cause: error })
    }),
    deadline.promise
  ])
  fixtureUrl = liveUrl
  const live = await fetch(liveUrl, {
    headers: { connection: 'close' },
    signal: AbortSignal.timeout(1000)
  })
  assert.equal(await live.text(), token, 'Descendant must serve HTTP before the timeout')

  const error = await Promise.race([outcome, deadline.promise])
  assert.ok(error instanceof Error, 'Expected the command to reject')
  assert.match(error.message, new RegExp(`timed out after ${timeoutMs}ms`))
  await assert.rejects(
    fetch(liveUrl, { signal: AbortSignal.timeout(1000) }),
    { code: 'ECONNREFUSED' },
    'Descendant fixture server must stop accepting connections after timeout'
  )
  console.log('Timed-out command and its descendant fixture server exited')
} finally {
  clearTimeout(watchdog)
  control.stop(true)
  if (fixtureUrl) {
    await fetch(fixtureUrl, { method: 'POST', signal: AbortSignal.timeout(1000) }).catch(
      () => undefined
    )
  }
}
