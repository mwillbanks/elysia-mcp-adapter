type CapturedTimer = {
  active: boolean
  callback: () => void
  delay: number
  unref(): CapturedTimer
}

const maximumTimerDelay = 2_147_483_647
const verificationTtlMs = maximumTimerDelay + 2_500
const nativeSetTimeout = globalThis.setTimeout
const nativeClearTimeout = globalThis.clearTimeout
const nativeDateNow = Date.now
const timers: CapturedTimer[] = []
let now = 1_700_000_000_000

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function runTimer(expectedDelay: number): void {
  const timer = timers.find((candidate) => candidate.active && candidate.delay === expectedDelay)
  assert(timer, `Missing active timer with delay ${expectedDelay}`)
  timer.active = false
  timer.callback()
}

globalThis.setTimeout = ((
  callback: (...arguments_: unknown[]) => void,
  delay = 0,
  ...arguments_: unknown[]
) => {
  const timer: CapturedTimer = {
    active: true,
    callback: () => callback(...arguments_),
    delay,
    unref: () => timer
  }
  timers.push(timer)
  return timer
}) as unknown as typeof setTimeout
globalThis.clearTimeout = ((timer: CapturedTimer | undefined) => {
  if (timer) timer.active = false
}) as typeof clearTimeout
Date.now = () => now

try {
  const [{ verifyWebhookEndpoint }, { normalizeOptions }] = await Promise.all([
    import('../../src/extensions/events/webhook.js'),
    import('../../src/options.js')
  ])
  let allowlistCalls = 0
  const getAllowlistCalls = () => allowlistCalls
  const normalized = normalizeOptions({
    transport: { protocolVersions: ['2025-11-25'] },
    extensions: {
      events: {
        cursor: { signingKey: 'verification-timer-fixture-signing-key' },
        webhook: {
          provider: { durability: 'durable' } as never,
          verificationTtlMs,
          allowlist: () => {
            allowlistCalls++
            return true
          },
          resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }]
        }
      }
    }
  })
  const options = normalized.extensions.events?.webhook
  assert(options, 'Webhook options were not normalized')
  const record = {
    key: 'verification-timer',
    id: 'sub_verification_timer',
    principal: 'timer-owner',
    name: 'com.example.timer',
    arguments: {},
    url: 'https://timer.example.test/hook',
    secret: `whsec_${Buffer.alloc(24).toString('base64')}`,
    refreshBefore: new Date(now + 60_000).toISOString(),
    verified: false,
    active: true,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  }
  const context = {
    request: new Request('http://localhost/mcp'),
    protocolVersion: '2025-11-25' as const
  }

  await verifyWebhookEndpoint(record, context, options)
  assert(
    getAllowlistCalls() === 1,
    'Initial verification did not consult the allowlist exactly once'
  )

  now += maximumTimerDelay
  runTimer(maximumTimerDelay)
  assert(
    timers.some((timer) => timer.active && timer.delay === 2_500),
    'Cleanup did not rearm for the remaining absolute lifetime'
  )

  await verifyWebhookEndpoint(record, context, options)
  assert(getAllowlistCalls() === 1, 'Cached consent expired before its absolute expiry')

  now += 2_500
  runTimer(2_500)
  await verifyWebhookEndpoint(record, context, options)
  assert(getAllowlistCalls() === 2, 'Expired consent did not require fresh authorization')

  now += verificationTtlMs
  runTimer(maximumTimerDelay)
  assert(!timers.some((timer) => timer.active), 'Cleanup left an active timer after cache expiry')

  console.log(
    JSON.stringify({
      scheduledDelays: [maximumTimerDelay, 2_500],
      allowlistCalls: getAllowlistCalls()
    })
  )
} finally {
  for (const timer of timers) timer.active = false
  globalThis.setTimeout = nativeSetTimeout
  globalThis.clearTimeout = nativeClearTimeout
  Date.now = nativeDateNow
}
