import { SqliteWebhookProvider } from './provider.js'

const [mode, database, requestedKey, requestedPrincipal] = process.argv.slice(2)
if (!mode || !database) throw new Error('Expected mode and database path')
const provider = new SqliteWebhookProvider(database, () => false)
if (mode === 'claim') {
  const key = requestedKey ?? 'claim'
  const principal = requestedPrincipal ?? 'owner'
  console.log(
    JSON.stringify(
      provider.upsert(
        {
          key,
          id: key,
          principal,
          name: 'event',
          arguments: {},
          url: `https://callback.test/${key}`,
          secret: 'whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB',
          refreshBefore: null,
          verified: true,
          active: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        { maxSubscriptionsPerPrincipal: 1 }
      )
    )
  )
} else if (mode === 'write') {
  provider.upsert(
    {
      key: 'owner/restart',
      id: 'restart',
      principal: 'owner',
      name: 'event',
      arguments: {},
      url: 'https://callback.test/hook',
      secret: 'whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB',
      refreshBefore: null,
      verified: true,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    { maxSubscriptionsPerPrincipal: 2 }
  )
  console.log('written')
} else {
  console.log(JSON.stringify(provider.get('owner/restart')))
}
provider.close()
