import { jsonRequest } from './client.js'
import { app } from './server.js'

const discovery = await jsonRequest(app, 'server/discover')
if (discovery.result?.supportedVersions?.[0] !== '2026-07-28') {
  throw new Error('Modern core discovery failed')
}
const completion = await jsonRequest(app, 'completion/complete', {
  ref: { type: 'ref/resource', uri: 'docs:///{name}' },
  argument: { name: 'name', value: 'guide' }
})
if (completion.result?.completion?.values?.[0] !== 'guide.md') {
  throw new Error('Modern core completion failed')
}
