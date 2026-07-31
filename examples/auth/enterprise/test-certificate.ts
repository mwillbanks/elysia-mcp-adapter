import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Creates an ephemeral IdP certificate for tests; no key or certificate is checked in. */
export async function createEphemeralIdpCertificate(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'elysia-mcp-saml-'))
  const keyPath = join(directory, 'idp.key')
  const certPath = join(directory, 'idp.crt')
  try {
    const process = Bun.spawn(
      [
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-subj',
        '/CN=elysia-mcp-test-idp',
        '-days',
        '1'
      ],
      { stdout: 'ignore', stderr: 'pipe' }
    )
    const exitCode = await process.exited
    if (exitCode !== 0) {
      throw new Error(`openssl failed: ${await new Response(process.stderr).text()}`)
    }
    return await readFile(certPath, 'utf8')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
