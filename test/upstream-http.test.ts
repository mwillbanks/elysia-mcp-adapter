import { describe, expect, spyOn, test } from 'bun:test'
import {
  readUpstreamBytes,
  readUpstreamJson,
  readUpstreamText,
  registryLatestVersion,
  upstreamString
} from '../scripts/upstream-http.js'

async function withUpstreamResponse(
  body: string,
  status: number,
  operation: (url: string) => Promise<void>
) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(body, { status, headers: { 'content-type': 'application/json' } })
  })
  try {
    await operation(server.url.href)
  } finally {
    server.stop(true)
  }
}

describe('upstream metadata transport', () => {
  test('sends registry JSON negotiation without forwarding GitHub credentials', async () => {
    let sent: Headers | undefined
    const registryFetch = Object.assign(
      async (_url: RequestInfo | URL, options?: RequestInit) => {
        sent = new Headers(options?.headers)
        return Response.json({ version: '2.3.1' })
      },
      { preconnect: fetch.preconnect }
    )
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(registryFetch)
    try {
      expect(
        await registryLatestVersion('example', {
          accept: 'application/vnd.github+json',
          authorization: 'Bearer fixture',
          'user-agent': 'audit'
        })
      ).toBe('2.3.1')
      expect(sent?.get('accept')).toBe('application/json')
      expect(sent?.has('authorization')).toBe(false)
      expect(sent?.get('user-agent')).toBe('audit')
    } finally {
      fetchSpy.mockRestore()
    }
  })
  test('preserves exact upstream source bytes and text', async () => {
    const body = 'published specification\n€'
    await withUpstreamResponse(body, 200, async (url) => {
      expect(await readUpstreamText(url, {})).toBe(body)
      expect(new Uint8Array(await readUpstreamBytes(url, {}))).toEqual(
        new TextEncoder().encode(body)
      )
    })
  })
  test('reads object metadata from an isolated upstream server', async () => {
    await withUpstreamResponse('{"version":"2.3.1"}', 200, async (url) => {
      const metadata = await readUpstreamJson(url, {})
      expect(upstreamString(metadata.version, 'latest version')).toBe('2.3.1')
    })
  })

  test('rejects upstream HTTP failures instead of reporting a successful audit', async () => {
    await withUpstreamResponse('{"error":"unavailable"}', 503, async (url) => {
      await expect(readUpstreamJson(url, {})).rejects.toThrow('Upstream request failed (503)')
    })
  })

  test('rejects non-object and malformed upstream documents', async () => {
    for (const body of ['[]', 'null', '"version"', '{']) {
      await withUpstreamResponse(body, 200, async (url) => {
        await expect(readUpstreamJson(url, {})).rejects.toThrow()
      })
    }
  })

  test('requires a nonempty string for upstream version fields', () => {
    for (const value of [undefined, null, '', 23, {}])
      expect(() => upstreamString(value, 'latest version')).toThrow(
        'Upstream omitted latest version'
      )
  })
})
