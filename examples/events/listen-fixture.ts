import type { Server } from 'node:https'

/** Bind an isolated TLS receiver and return its assigned loopback port. */
export async function listenLoopbackTls(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing TLS fixture address')
  return address.port
}
