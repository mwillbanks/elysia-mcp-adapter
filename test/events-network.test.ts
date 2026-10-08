import { describe, expect, test } from 'bun:test'
import {
  isGloballyRoutableAddress,
  McpWebhookNetworkError,
  parseWebhookUrl,
  postWebhook,
  resolveWebhookEndpoint
} from '../src/extensions/events/network.js'
import { within } from './events-test-helpers.js'

const fixture = new URL('./fixtures/events-network/runner.ts', import.meta.url)
const ca = new URL('./fixtures/events-network/ca.pem', import.meta.url)

async function runTlsFixture(mode: string, family: 'ipv4' | 'ipv6' = 'ipv4') {
  const child = Bun.spawn([process.execPath, fixture.pathname, mode, family], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: ca.pathname,
      ...(mode === 'ambient-insecure' ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
      HTTPS_PROXY: 'http://127.0.0.1:1',
      https_proxy: 'http://127.0.0.1:1'
    },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const deadline = setTimeout(() => child.kill(), 2_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).finally(() => clearTimeout(deadline))
  expect(exitCode, stderr).toBe(0)
  return JSON.parse(stdout.trim()) as {
    ok: boolean
    status?: number
    body?: string
    reason?: string
    resolvedCalls?: number
    proxyConnections?: number
    proxyControlConnections?: number
    productionProxyConnections?: number
    observed: Record<string, unknown>
  }
}

describe('webhook network boundary', () => {
  test('parses only credential-free HTTPS callback URLs', () => {
    expect(parseWebhookUrl('https://example.com/hook').hostname).toBe('example.com')
    for (const value of [
      'http://example.com/hook',
      'https://user@example.com/hook',
      'https://example.com/hook#fragment',
      'not a URL'
    ])
      expect(() => parseWebhookUrl(value)).toThrow()
  })

  test('connects directly to the chosen IPv4 while preserving DNS SNI and Host', async () => {
    const result = await runTlsFixture('success')
    expect(result).toMatchObject({ ok: true, status: 202, body: 'accepted' })
    expect(result.proxyControlConnections).toBe(1)
    expect(result.productionProxyConnections).toBe(0)
    expect(result.observed).toMatchObject({
      host: expect.stringMatching(/^callback\.test:/),
      servername: 'callback.test',
      remoteAddress: '127.0.0.1',
      method: 'POST',
      url: '/hook?source=test'
    })
  })

  test('uses IPv6 directly when loopback IPv6 is available', async () => {
    let probe: { stop(closeActiveConnections?: boolean): void } | undefined
    try {
      probe = Bun.listen({ hostname: '::1', port: 0, socket: { data() {} } })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') return
      throw error
    } finally {
      probe?.stop(true)
    }
    const result = await runTlsFixture('success', 'ipv6')
    expect(result.ok).toBe(true)
    expect(String(result.observed.remoteAddress)).toContain('::1')
  })

  test('keeps certificate verification enabled and rejects a wrong DNS SAN', async () => {
    expect(await runTlsFixture('invalid-san')).toMatchObject({ ok: false, reason: 'tls_error' })
  })

  test('rejects a wrong DNS SAN despite an ambient insecure TLS override', async () => {
    expect(await runTlsFixture('ambient-insecure')).toMatchObject({
      ok: false,
      reason: 'tls_error'
    })
  })

  test('performs fresh DNS resolution for every delivery', async () => {
    expect(await runTlsFixture('fresh-dns')).toMatchObject({
      ok: true,
      resolvedCalls: 2
    })
  })

  test('does not follow redirects and bounds or rejects incomplete response bodies', async () => {
    expect(await runTlsFixture('redirect')).toMatchObject({
      ok: true,
      status: 302,
      body: 'redirect'
    })
    expect(await runTlsFixture('oversize')).toMatchObject({ ok: false, reason: 'http_5xx' })
    expect(await runTlsFixture('early-close')).toMatchObject({
      ok: false,
      reason: 'connection_refused'
    })
  })

  test('resolves every delivery and rejects rebinding to blocked address classes', async () => {
    let calls = 0
    const endpoint = new URL('https://callback.test/hook')
    const options = {
      allowPrivateAddresses: false,
      resolveAddresses: async () => {
        calls += 1
        return calls === 1
          ? [{ address: '192.0.0.9', family: 4 as const }]
          : [{ address: '127.0.0.1', family: 4 as const }]
      }
    }
    expect(await resolveWebhookEndpoint(endpoint, options)).toEqual([
      { address: '192.0.0.9', family: 4 }
    ])
    await expect(resolveWebhookEndpoint(endpoint, options)).rejects.toMatchObject({
      reason: 'connection_refused'
    })
    expect(calls).toBe(2)

    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.168.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
      '::',
      '::1',
      '::ffff:8.8.8.8',
      '64:ff9b::7f00:1',
      '100::1',
      '2001:db8::1',
      'fc00::1',
      'fe80::1',
      'ff00::1'
    ])
      expect(isGloballyRoutableAddress(address), address).toBe(false)
  })

  test('honors longest-prefix IANA global exceptions', () => {
    expect(isGloballyRoutableAddress('192.0.0.8')).toBe(false)
    expect(isGloballyRoutableAddress('192.0.0.9')).toBe(true)
    expect(isGloballyRoutableAddress('192.0.0.10')).toBe(true)
    expect(isGloballyRoutableAddress('2001:1::1')).toBe(true)
    expect(isGloballyRoutableAddress('2001:2::1')).toBe(false)
    expect(isGloballyRoutableAddress('2001:3::1')).toBe(true)
  })

  test('bounds hanging DNS, honors pre-abort, and cancels an active request', async () => {
    const endpoint = new URL('https://callback.test/hook')
    const hanging = () => new Promise<never>(() => {})
    await expect(
      within(
        postWebhook(
          endpoint,
          new Uint8Array(),
          {},
          {
            allowPrivateAddresses: true,
            resolveAddresses: hanging,
            requestTimeoutMs: 25,
            maxResponseBytes: 16
          }
        ),
        'hanging DNS request timeout'
      )
    ).rejects.toMatchObject({ reason: 'timeout' })

    const preAborted = new AbortController()
    preAborted.abort('cancelled')
    await expect(
      postWebhook(
        endpoint,
        new Uint8Array(),
        {},
        {
          allowPrivateAddresses: true,
          resolveAddresses: hanging,
          requestTimeoutMs: 5_000,
          maxResponseBytes: 16
        },
        preAborted.signal
      )
    ).rejects.toBeInstanceOf(McpWebhookNetworkError)

    const active = new AbortController()
    const pending = postWebhook(
      endpoint,
      new Uint8Array(),
      {},
      {
        allowPrivateAddresses: true,
        resolveAddresses: hanging,
        requestTimeoutMs: 5_000,
        maxResponseBytes: 16
      },
      active.signal
    )
    active.abort('cancelled')
    await expect(pending).rejects.toMatchObject({ reason: 'timeout' })
  })

  test('aborts and times out active TLS sockets after the receiver observes the request', async () => {
    expect(await runTlsFixture('active-abort')).toMatchObject({
      ok: false,
      reason: 'timeout',
      observed: { method: 'POST', url: '/hook?source=test' }
    })
    expect(await runTlsFixture('active-timeout')).toMatchObject({
      ok: false,
      reason: 'timeout',
      observed: { method: 'POST', url: '/hook?source=test' }
    })
  })
})
