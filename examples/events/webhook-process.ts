import { refreshWebhook, subscribeWebhook, unsubscribeWebhook } from './client.js'
import { createWebhookEventApp } from './webhook-server.js'

const [mode, database, url, receiverLog] = process.argv.slice(2)
if (!mode || !database || !url || !receiverLog)
  throw new Error('Expected mode, database, URL, and receiver log')
const accessToken = process.env.EVENTS_FIXTURE_ACCESS_TOKEN
if (!accessToken) throw new Error('EVENTS_FIXTURE_ACCESS_TOKEN is required')
const { app, provider, publishWebhookEvent } = createWebhookEventApp(database, {
  accessToken,
  authorizeDelivery: (storedPrincipal, authorization) =>
    authorization.principal.subject === 'owner' && storedPrincipal.includes('owner')
})
const tuple = { name: 'com.example.webhook', arguments: {}, url }
const oldSecret = 'whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB'
const newSecret = 'whsec_AgICAgICAgICAgICAgICAgICAgICAgIC'
const authorization = `Bearer ${accessToken}`
interface ReceiverEntry {
  kind?: string
  duplicate?: boolean
  signature?: string
}
const deliveries = async () => {
  const file = Bun.file(receiverLog)
  if (!(await file.exists())) return []
  return (await file.text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReceiverEntry)
}
const waitFor = async (predicate: (entries: ReceiverEntry[]) => boolean, produce?: () => void) => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const entries = await deliveries()
    if (predicate(entries)) return entries
    produce?.()
    await Bun.sleep(5)
  }
  throw new Error('Observed webhook delivery timed out')
}
if (mode === 'subscribe') {
  const subscribed = await subscribeWebhook(app, tuple, oldSecret, null, 1, authorization, {
    maxAgeMs: 15_000
  })
  if (subscribed.body.error) throw new Error(JSON.stringify(subscribed.body.error))
  await waitFor(
    (entries) => entries.some(({ kind, duplicate }) => kind === 'event' && !duplicate),
    publishWebhookEvent
  )
  const refreshed = await refreshWebhook(
    app,
    tuple,
    newSecret,
    subscribed.body.result.cursor,
    999_999,
    authorization,
    { maxAgeMs: 15_000 }
  )
  if (refreshed.body.error) throw new Error(JSON.stringify(refreshed.body.error))
  await waitFor(
    (entries) =>
      entries.some(({ signature }) => typeof signature === 'string' && signature.includes(' ')),
    publishWebhookEvent
  )
  console.log(
    JSON.stringify({
      subscribed: subscribed.body.result.id,
      refreshed: refreshed.body.result.id,
      freshCursor: subscribed.body.result.cursor,
      freshTruncated: subscribed.body.result.truncated,
      observedAt: new Date().toISOString(),
      minimumRefreshBefore: subscribed.body.result.refreshBefore,
      maximumRefreshBefore: refreshed.body.result.refreshBefore
    })
  )
  provider.close()
  process.exit(0)
} else {
  const initialEvents = (await deliveries()).filter(
    ({ kind, duplicate }) => kind === 'event' && !duplicate
  ).length
  await waitFor(
    (entries) =>
      entries.filter(({ kind, duplicate }) => kind === 'event' && !duplicate).length >
      initialEvents,
    publishWebhookEvent
  )
  const removed = await unsubscribeWebhook(app, tuple, authorization)
  if (removed.body.error) throw new Error(JSON.stringify(removed.body.error))
  console.log(JSON.stringify({ recovered: true, removed: true }))
  provider.close()
}
