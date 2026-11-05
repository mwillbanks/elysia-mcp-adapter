import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { Elysia } from 'elysia'
import {
  authorizeOAuthRequest,
  MCP_DPOP_DRAFT_REVISION,
  mcp,
  type McpAuthOptions,
  type McpDpopOptions,
  normalizeDpopOptions
} from '../src/index.js'
import {
  parseDpopAuthorization,
  verifyDpopProof,
  type McpDpopReplayClaim
} from '../src/extensions/auth/dpop.js'

// RFC 9449 Figures 8 and 13 supply an independent proof and confirmation thumbprint.
const exampleToken = 'Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU'
const exampleJkt = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I'
const exampleProof = [
  'eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6Ik',
  'VDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCR',
  'nMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JE',
  'QSIsImNydiI6IlAtMjU2In19.eyJqdGkiOiJlMWozVl9iS2ljOC1MQUVCIiwiaHRtIj',
  'oiR0VUIiwiaHR1IjoiaHR0cHM6Ly9yZXNvdXJjZS5leGFtcGxlLm9yZy9wcm90ZWN0Z',
  'WRyZXNvdXJjZSIsImlhdCI6MTU2MjI2MjYxOCwiYXRoIjoiZlVIeU8ycjJaM0RaNTNF',
  'c05yV0JiMHhXWG9hTnk1OUlpS0NBcWtzbVFFbyJ9.2oW9RP35yRqzhrtNP86L-Ey71E',
  'OptxRimPPToA1plemAgR6pxHF8y6-yqyVnmcw6Fy1dqd-jfxSYoMxhAJpLjA'
].join('')

const nowSeconds = 1_562_262_618
const target = 'https://resource.example.org/protectedresource'
const token = 'dpop-bound-test-token'
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = publicKey.export({ format: 'jwk' })
const hash = (value: string) => createHash('sha256').update(value, 'ascii').digest('base64url')
const jkt = hash(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
const invalidProof = { ok: false, error: 'invalid_dpop_proof' } as const
const invalidToken = { ok: false, error: 'invalid_token' } as const

function signProof(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const proofHeader = { typ: 'dpop+jwt', alg: 'ES256', jwk, ...header }
  const proofClaims = {
    jti: 'proof-01',
    htm: 'GET',
    htu: target,
    iat: nowSeconds,
    ath: hash(token),
    ...claims
  }
  const segments = [proofHeader, proofClaims].map((value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  )
  const data = segments.join('.')
  const signature = sign('sha256', Buffer.from(data), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url')
  return data + '.' + signature
}

function requestWithProof(proof: string, url = target, method = 'GET'): Request {
  return new Request(url, {
    method,
    headers: { DPoP: proof, Forwarded: 'host=other.example;proto=http' }
  })
}

describe('DPoP credentials', () => {
  test('parses only a single scheme and token68 credential', () => {
    expect(parseDpopAuthorization(null)).toEqual({ ok: false, reason: 'missing' })
    expect(parseDpopAuthorization('dPoP  az-._~+/09==')).toEqual({
      ok: true,
      token: 'az-._~+/09=='
    })
    for (const header of [
      'Bearer token',
      'DPoP',
      'DPoP\ttoken',
      'DPoP token extra',
      'DPoP token=more',
      'DPoP abc, DPoP def',
      'DPoP ' + 'a'.repeat(16_385)
    ]) {
      expect(parseDpopAuthorization(header)).toEqual({ ok: false, reason: 'malformed' })
    }
  })
})

describe('DPoP proof', () => {
  test('verifies the RFC vector against the normalized actual target', async () => {
    const request = requestWithProof(
      exampleProof,
      'https://RESOURCE.EXAMPLE.ORG:443/./%70rotectedresource?q=a#local'
    )
    expect(await verifyDpopProof(request, exampleToken, exampleJkt, { nowSeconds })).toEqual({
      ok: true
    })
  })

  test('rejects a valid signature over a matching cleartext request target', async () => {
    const cleartext = 'http://resource.example.org/protectedresource'
    const proof = signProof({ htu: cleartext })
    const request = requestWithProof(proof, cleartext)
    expect(await verifyDpopProof(request, token, jkt, { nowSeconds })).toEqual(invalidProof)
  })

  test('rejects wrong token hash separately from wrong key confirmation', async () => {
    const request = requestWithProof(exampleProof)
    expect(await verifyDpopProof(request, token, exampleJkt, { nowSeconds })).toEqual(invalidProof)
    expect(await verifyDpopProof(request, exampleToken, jkt, { nowSeconds })).toEqual(invalidToken)
    expect(await verifyDpopProof(request, exampleToken, undefined, { nowSeconds })).toEqual(
      invalidToken
    )
  })

  test('accepts only a compact JWT and rejects duplicate proof headers', async () => {
    const [header, claims] = exampleProof.split('.')
    for (const request of [
      new Request(target),
      new Request(target, {
        headers: [
          ['DPoP', exampleProof],
          ['dpop', exampleProof]
        ]
      }),
      requestWithProof(exampleProof + '='),
      requestWithProof(exampleProof + '.'),
      requestWithProof('a'.repeat(16_385)),
      requestWithProof(header + '.' + claims + '.' + 'A'.repeat(86)),
      requestWithProof('W10.' + claims + '.' + 'A'.repeat(86)),
      requestWithProof('_w.' + claims + '.' + 'A'.repeat(86))
    ]) {
      expect(await verifyDpopProof(request, exampleToken, exampleJkt, { nowSeconds })).toEqual(
        invalidProof
      )
    }
  })

  test('enforces ES256, the proof media type, and a public embedded P-256 key', async () => {
    for (const header of [
      { typ: 'JWT' },
      { alg: 'none' },
      { alg: 'HS256' },
      { crit: ['b64'], b64: false },
      { jku: 'https://other.example/keyset' },
      { jwk: { ...jwk, d: 'private' } },
      { jwk: { ...jwk, x5u: 'https://other.example/certificate' } },
      { jwk: { ...jwk, use: 'enc' } },
      { jwk: { ...jwk, key_ops: ['sign'] } },
      { jwk: { ...jwk, x: 'A'.repeat(43), y: 'A'.repeat(43) } }
    ]) {
      const request = requestWithProof(signProof({}, header))
      expect(await verifyDpopProof(request, token, jkt, { nowSeconds })).toEqual(invalidProof)
    }

    const publicMetadata = { ...jwk, key_ops: ['verify'], ext: true, alg: 'ES256', use: 'sig' }
    const request = requestWithProof(signProof({}, { jwk: publicMetadata }))
    expect(await verifyDpopProof(request, token, jkt, { nowSeconds })).toEqual({ ok: true })
  })

  test('binds the proof to the exact method, URI origin, and resource path', async () => {
    for (const claims of [
      { jti: '' },
      { jti: 'has\u0000control' },
      { jti: 'x'.repeat(257) },
      { iat: String(nowSeconds) },
      { ath: undefined },
      { htm: 'get' },
      { htm: 'POST' },
      { htu: 'http://other.example/protectedresource' },
      { htu: target + '?search=x' },
      { htu: target + '#fragment' },
      { htu: 'https://user@resource.example.org/protectedresource' },
      { htu: 'https:///resource.example.org/protectedresource' },
      { htu: 'https://resource.example.org\\protectedresource' }
    ]) {
      const request = requestWithProof(signProof(claims))
      expect(await verifyDpopProof(request, token, jkt, { nowSeconds })).toEqual(invalidProof)
    }

    const proof = signProof({ htu: target + '/%2f' })
    const sameEncodedPath = requestWithProof(proof, target + '/%2F')
    expect(await verifyDpopProof(sameEncodedPath, token, jkt, { nowSeconds })).toEqual({ ok: true })
    const differentPath = requestWithProof(proof, target + '//')
    expect(await verifyDpopProof(differentPath, token, jkt, { nowSeconds })).toEqual(invalidProof)
  })

  test('uses an inclusive 300-second window and rejects invalid clocks and widened windows', async () => {
    const request = requestWithProof(exampleProof)
    for (const offset of [-300, 300]) {
      expect(
        await verifyDpopProof(request, exampleToken, exampleJkt, {
          nowSeconds: nowSeconds + offset
        })
      ).toEqual({ ok: true })
    }
    for (const offset of [-301, 301, Number.NaN, Infinity, Number.MAX_VALUE]) {
      expect(
        await verifyDpopProof(request, exampleToken, exampleJkt, {
          nowSeconds: nowSeconds + offset
        })
      ).toEqual(invalidProof)
    }
    for (const maxAgeSeconds of [-1, 0, 301, Number.NaN]) {
      expect(
        await verifyDpopProof(request, exampleToken, exampleJkt, { nowSeconds, maxAgeSeconds })
      ).toEqual(invalidProof)
    }
    expect(
      await verifyDpopProof(request, exampleToken, exampleJkt, {
        nowSeconds: nowSeconds + 11,
        maxAgeSeconds: 10
      })
    ).toEqual(invalidProof)
  })

  test('reserves replay state only after proof and binding verification', async () => {
    const request = requestWithProof(signProof())
    const accepted: McpDpopReplayClaim[] = []
    const options = {
      nowSeconds,
      acceptReplay: async (claim: McpDpopReplayClaim) => {
        if (accepted.some((entry) => entry.jti === claim.jti)) return false
        accepted.push(claim)
        return true
      }
    }

    expect(await verifyDpopProof(request, 'other-token', jkt, options)).toEqual(invalidProof)
    expect(await verifyDpopProof(request, token, exampleJkt, options)).toEqual(invalidToken)
    expect(accepted).toEqual([])
    const results = await Promise.all([
      verifyDpopProof(request, token, jkt, options),
      verifyDpopProof(request, token, jkt, options)
    ])
    expect(results).toEqual(expect.arrayContaining([{ ok: true }, invalidProof]))
    expect(accepted).toEqual([
      { jti: 'proof-01', jkt, resource: target, expiresAt: nowSeconds + 301 }
    ])
    expect(
      await verifyDpopProof(request, token, jkt, {
        nowSeconds,
        acceptReplay: async () => {
          throw new Error('Replay provider unavailable')
        }
      })
    ).toEqual(invalidProof)
  })
})

const endpoint = 'https://localhost/mcp'
const issuer = 'https://auth.example.com'
const ordinaryToken = 'ordinary-bearer'

function endpointPrincipal(credential: string) {
  return {
    tokenType: 'access_token' as const,
    subject: 'verified-subject',
    issuer,
    audience: endpoint,
    expiresAt: nowSeconds + 600,
    scopes: ['mcp'],
    dpopJkt: credential === ordinaryToken ? undefined : jkt
  }
}

function endpointApp(dpop: McpAuthOptions['dpop'], overrides: Partial<McpAuthOptions> = {}) {
  return new Elysia()
    .use(
      mcp({
        extensions: {
          auth: {
            resource: endpoint,
            authorizationServers: [issuer],
            scopes: ['mcp'],
            dpop,
            verifyAccessToken: endpointPrincipal,
            ...overrides
          }
        }
      })
    )
    .mcpTool('restricted', () => 'authorized', {
      authorization: { requiredScopes: ['admin'] }
    })
}

async function endpointRpc(
  app: ReturnType<typeof endpointApp>,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  url = endpoint,
  id = 1
) {
  const response = await app.handle(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
        ...headers
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'dpop-tests', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    })
  )
  return { status: response.status, headers: response.headers, body: await response.json() }
}

function endpointProof(method = 'POST'): string {
  return signProof({ htu: endpoint, htm: method })
}

function dpopHeaders(proof = endpointProof()) {
  return { authorization: 'DPoP ' + token, dpop: proof }
}

describe('DPoP resource-server admission', () => {
  beforeEach(() => setSystemTime(new Date(nowSeconds * 1000)))
  afterEach(() => setSystemTime())

  test('discovery describes the enforced policy even when metadata supplies conflicting values', async () => {
    const metadataPath = 'https://localhost/.well-known/oauth-protected-resource/mcp'
    const metadata: McpAuthOptions['metadata'] = {
      dpopSigningAlgValuesSupported: ['RS256'],
      dpopBoundAccessTokensRequired: true,
      additionalMetadata: {
        dpop_signing_alg_values_supported: ['RS256'],
        dpop_bound_access_tokens_required: true,
        custom: 'kept'
      }
    }
    const disabled = await endpointApp(undefined, { metadata }).handle(new Request(metadataPath))
    const off = await disabled.json()
    expect(off).not.toHaveProperty('dpop_signing_alg_values_supported')
    expect(off).not.toHaveProperty('dpop_bound_access_tokens_required')
    expect(off).toMatchObject({ bearer_methods_supported: ['header'], custom: 'kept' })

    const optional = await endpointApp({ stateless: true }, { metadata }).handle(
      new Request(metadataPath)
    )
    expect(await optional.json()).toMatchObject({
      bearer_methods_supported: ['header'],
      dpop_signing_alg_values_supported: ['ES256'],
      dpop_bound_access_tokens_required: false
    })

    const required = await endpointApp({ required: true, stateless: true }, { metadata }).handle(
      new Request(metadataPath)
    )
    expect(await required.json()).toMatchObject({
      bearer_methods_supported: [],
      dpop_signing_alg_values_supported: ['ES256'],
      dpop_bound_access_tokens_required: true
    })
  })

  test('requires HTTPS in discovery configuration and on the actual request URL', async () => {
    const cleartextLoopback = 'http://localhost/mcp'
    expect(() => endpointApp({ stateless: true }, { resource: cleartextLoopback })).toThrow(
      'DPoP protected resource identifiers must use HTTPS'
    )
    expect(() => endpointApp(undefined, { resource: cleartextLoopback })).not.toThrow()

    let reservations = 0
    const app = endpointApp({
      acceptReplay: () => {
        reservations += 1
        return true
      }
    })
    for (const actualUrl of [cleartextLoopback, 'http://resource.example.org/mcp']) {
      const proof = signProof({ htu: actualUrl, htm: 'POST' })
      const denied = await endpointRpc(
        app,
        'server/discover',
        {},
        { ...dpopHeaders(proof), forwarded: 'proto=https', 'x-forwarded-proto': 'https' },
        actualUrl
      )
      expect(denied.status).toBe(401)
      expect(denied.body).toEqual({ error: 'invalid_dpop_proof' })
    }
    expect(reservations).toBe(0)
  })

  test('admits bound tokens only with DPoP and preserves configured ordinary Bearer support', async () => {
    for (const selection of [
      undefined,
      { stateless: true },
      { required: true, stateless: true }
    ] as const) {
      const app = endpointApp(selection)
      const downgrade = await endpointRpc(
        app,
        'server/discover',
        {},
        { authorization: 'Bearer ' + token }
      )
      expect(downgrade.status).toBe(401)
      expect(downgrade.body).toEqual({ error: 'invalid_token' })

      const unbound = await endpointRpc(
        app,
        'server/discover',
        {},
        {
          authorization: 'Bearer ' + ordinaryToken
        }
      )
      expect(unbound.status).toBe(selection && 'required' in selection ? 401 : 200)

      const bound = await endpointRpc(app, 'server/discover', {}, dpopHeaders())
      expect(bound.status).toBe(selection ? 200 : 401)
    }
  })

  test('offers the configured schemes and attaches errors only to the attempted scheme', async () => {
    const app = endpointApp({ stateless: true })
    const missing = await endpointRpc(app, 'server/discover')
    const discovery = missing.headers.get('www-authenticate')
    expect(missing.status).toBe(401)
    expect(discovery).toStartWith('Bearer ')
    expect(discovery).toContain(', DPoP ')
    expect(discovery).toContain('algs="ES256"')
    expect(discovery).not.toContain('error=')

    const invalid = await endpointRpc(
      app,
      'server/discover',
      {},
      { authorization: 'DPoP ' + token }
    )
    expect(invalid.status).toBe(401)
    expect(invalid.body).toEqual({ error: 'invalid_dpop_proof' })
    const challenge = invalid.headers.get('www-authenticate') ?? ''
    const [bearerChallenge, dpopChallenge] = challenge.split(', DPoP ')
    expect(bearerChallenge).not.toContain('error=')
    expect(dpopChallenge).toContain('error="invalid_dpop_proof"')

    const required = await endpointRpc(
      endpointApp({ required: true, stateless: true }),
      'server/discover'
    )
    expect(required.headers.get('www-authenticate')).toStartWith('DPoP ')
  })

  test('checks base scopes after proof validation and preserves the scheme on tool scope denial', async () => {
    const reserved: McpDpopReplayClaim[] = []
    const policy = {
      acceptReplay: (claim: McpDpopReplayClaim) => {
        reserved.push(claim)
        return true
      }
    }

    const base = endpointApp(policy, { scopes: ['admin'] })
    const invalid = await endpointRpc(base, 'server/discover', {}, dpopHeaders('invalid-proof'))
    expect(invalid.status).toBe(401)
    const baseScope = await endpointRpc(base, 'server/discover', {}, dpopHeaders())
    expect(baseScope.status).toBe(403)
    expect(baseScope.headers.get('www-authenticate')).toStartWith('DPoP ')
    expect(baseScope.headers.get('www-authenticate')).toContain('scope="admin"')
    expect(reserved).toEqual([])

    const valid = await endpointRpc(
      endpointApp(policy),
      'tools/call',
      {
        name: 'restricted',
        arguments: {}
      },
      dpopHeaders()
    )
    expect(valid.status).toBe(403)
    expect(valid.headers.get('www-authenticate')).toStartWith('DPoP ')
    expect(valid.headers.get('www-authenticate')).toContain('scope="admin"')
    expect(reserved).toHaveLength(1)
  })

  test('checks token issuer, audience, and expiry before reserving a proof', async () => {
    let reservations = 0
    for (const invalid of [
      { issuer: 'https://untrusted.example' },
      { audience: 'https://other.example/mcp' },
      { expiresAt: nowSeconds }
    ]) {
      const app = endpointApp(
        {
          acceptReplay: () => {
            reservations += 1
            return true
          }
        },
        { verifyAccessToken: () => ({ ...endpointPrincipal(token), ...invalid }) }
      )
      const denied = await endpointRpc(app, 'server/discover', {}, dpopHeaders())
      expect(denied.status).toBe(401)
      expect(denied.body).toEqual({ error: 'invalid_token' })
    }
    expect(reservations).toBe(0)
  })

  test('rejects replay and provider failure without exposing credentials or exception text', async () => {
    const proof = endpointProof()
    const credentials = dpopHeaders(proof)
    const accepted = new Set<string>()
    const app = endpointApp({
      acceptReplay: ({ jti }) => {
        if (accepted.has(jti)) throw new Error(proof + token)
        accepted.add(jti)
        return true
      }
    })
    expect((await endpointRpc(app, 'server/discover', {}, credentials)).status).toBe(200)

    const replay = await endpointRpc(app, 'server/discover', {}, credentials)
    expect(replay.status).toBe(401)
    expect(replay.body).toEqual({ error: 'invalid_dpop_proof' })
    expect(replay.headers.get('www-authenticate')).not.toContain(proof)
    expect(replay.headers.get('www-authenticate')).not.toContain(token)
  })

  test('rejects query credentials before the verifier and checks proof on auxiliary methods', async () => {
    let verifierCalls = 0
    const app = endpointApp(
      { stateless: true },
      {
        verifyAccessToken: () => {
          verifierCalls += 1
          return endpointPrincipal(token)
        }
      }
    )
    const query = await app.handle(new Request(endpoint + '?access_token=ignored'))
    expect(query.status).toBe(401)
    expect(await query.json()).toEqual({ error: 'invalid_request' })
    expect(verifierCalls).toBe(0)

    for (const method of ['GET', 'DELETE']) {
      const wrongMethod = await app.handle(
        new Request(endpoint, { method, headers: dpopHeaders() })
      )
      expect(wrongMethod.status).toBe(401)
      const valid = await app.handle(
        new Request(endpoint, { method, headers: dpopHeaders(endpointProof(method)) })
      )
      expect(valid.status).toBe(405)
    }
  })

  test('requires an explicit and exclusive replay policy at both configuration entry points', async () => {
    for (const invalid of [
      true,
      {},
      { stateless: false },
      { acceptReplay: 'not-a-function' },
      { stateless: true, acceptReplay: () => true }
    ]) {
      const dpop = invalid as McpDpopOptions
      expect(() => endpointApp(dpop)).toThrow('requires exactly one replay policy')
      await expect(
        authorizeOAuthRequest(new Request(endpoint), {
          dpop,
          resource: endpoint,
          verifier: endpointPrincipal
        })
      ).rejects.toThrow('requires exactly one replay policy')
    }
  })

  test('reserves captured proofs across distinct JSON-RPC IDs before tool execution', async () => {
    const reservations = new Set<string>()
    let executions = 0
    const app = endpointApp({
      acceptReplay: ({ resource, jkt, jti }) => {
        const key = JSON.stringify([resource, jkt, jti])
        if (reservations.has(key)) return false
        reservations.add(key)
        return true
      }
    }).mcpTool('replay-probe', () => {
      executions += 1
      return 'executed'
    })
    const credentials = dpopHeaders()
    const params = { name: 'replay-probe', arguments: {} }
    expect((await endpointRpc(app, 'tools/call', params, credentials, endpoint, 1)).status).toBe(
      200
    )
    const replay = await endpointRpc(app, 'tools/call', params, credentials, endpoint, 2)
    expect(replay.status).toBe(401)
    expect(replay.body).toEqual({ error: 'invalid_dpop_proof' })
    expect(executions).toBe(1)
  })

  test('allows replay inside the freshness window only with deliberate stateless configuration', async () => {
    let executions = 0
    const app = endpointApp({ stateless: true }).mcpTool('replay-probe', () => {
      executions += 1
      return 'executed'
    })
    const credentials = dpopHeaders()
    const params = { name: 'replay-probe', arguments: {} }
    for (const id of [1, 2]) {
      expect((await endpointRpc(app, 'tools/call', params, credentials, endpoint, id)).status).toBe(
        200
      )
    }
    expect(executions).toBe(2)
  })

  test('resolves the draft selector and rejects obsolete pins and unsafe validity windows', () => {
    expect(normalizeDpopOptions({ version: 'draft', stateless: true })).toMatchObject({
      version: MCP_DPOP_DRAFT_REVISION,
      maxAgeSeconds: 300,
      required: false
    })
    expect(normalizeDpopOptions({ version: MCP_DPOP_DRAFT_REVISION, stateless: true })).toEqual(
      normalizeDpopOptions({ stateless: true })
    )
    expect(() =>
      endpointApp({ version: 'obsolete' as typeof MCP_DPOP_DRAFT_REVISION, stateless: true })
    ).toThrow('review the current DPoP wire contract')
    for (const maxAgeSeconds of [0, 301, Number.NaN]) {
      expect(() => endpointApp({ maxAgeSeconds, stateless: true })).toThrow('at most 300')
    }
  })
})
