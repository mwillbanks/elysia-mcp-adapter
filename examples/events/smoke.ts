import { rpc } from './client.js'
import { app } from './server.js'

const listed = await rpc(app, 'events/list')
if (listed.body.result?.events?.[0]?.name !== 'com.example.build.changed')
  throw new Error('Events example discovery failed')
