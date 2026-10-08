import { describe, expect, test } from 'bun:test'
import {
  authorizeBearerRequest,
  authProfileCapabilities,
  buildBearerChallenge,
  buildProtectedResourceMetadata,
  filterAuthorizedScopes,
  isPrincipalExpired,
  MCP_CLIENT_CREDENTIALS_EXTENSION,
  MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION,
  missingRequiredScopes,
  parseBearerAuthorization,
  protectedResourceMetadataPath,
  protectedResourceMetadataPaths,
  protectedResourceMetadataUrl,
  resolveAuthVersion
} from '../src/extensions/auth/index.js'

describe('authorization profile versions', () => {
  test('resolves current versions independently', () => {
    expect(resolveAuthVersion('core')).toBe('2026-07-28')
    expect(resolveAuthVersion('enterprise-managed')).toBe('2026-06-17')
    expect(resolveAuthVersion('client-credentials')).toBe('draft')
    expect(resolveAuthVersion('core', 'draft')).toBe('draft')
    expect(resolveAuthVersion('core', '2025-11-25')).toBe('2025-11-25')
    expect(() => resolveAuthVersion('core', '2026-06-17')).toThrow('Supported versions')
  })

  test('advertises only explicitly enabled profiles', () => {
    expect(authProfileCapabilities()).toEqual({})
    expect(
      authProfileCapabilities({
        clientCredentials: true,
        enterpriseManaged: true
      })
    ).toEqual({
      [MCP_CLIENT_CREDENTIALS_EXTENSION]: {},
      [MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION]: {}
    })
  })
})

describe('protected resource metadata', () => {
  test('uses the RFC 9728 path form for root and path resources', () => {
    expect(protectedResourceMetadataPath('https://mcp.example.com/')).toBe(
      '/.well-known/oauth-protected-resource'
    )
    expect(protectedResourceMetadataPath('https://mcp.example.com/mcp/v1')).toBe(
      '/.well-known/oauth-protected-resource/mcp/v1'
    )
    expect(protectedResourceMetadataUrl('https://mcp.example.com/mcp').href).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'
    )
    expect(protectedResourceMetadataPaths('https://mcp.example.com/mcp', true)).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource'
    ])
  })

  test('builds a metadata body without allowing authoritative overrides', () => {
    expect(
      buildProtectedResourceMetadata({
        resource: 'https://mcp.example.com/mcp',
        authorizationServers: ['https://auth.example.com'],
        scopesSupported: ['tools:read', 'tools:read', 'tools:write'],
        resourceName: 'Example MCP',
        additionalMetadata: {
          resource: 'https://attacker.example',
          custom: 'value'
        }
      })
    ).toEqual({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['tools:read', 'tools:write'],
      resource_name: 'Example MCP',
      custom: 'value'
    })
  })

  test('rejects unsafe resource identifiers', () => {
    expect(() => protectedResourceMetadataPath('http://mcp.example.com/mcp')).toThrow(
      'must use HTTPS'
    )
    expect(() => protectedResourceMetadataPath('https://mcp.example.com/mcp?q=secret')).toThrow(
      'cannot contain'
    )
  })
})

describe('Bearer syntax and challenges', () => {
  test('accepts the complete RFC 6750 b64token syntax without changing it', () => {
    const token = 'AbC-._~+/012=='
    expect(parseBearerAuthorization(`bEaReR  ${token}`)).toEqual({
      ok: true,
      token
    })
  })

  test('rejects non-Bearer, whitespace, multiple credentials, and empty tokens', () => {
    for (const authorization of [
      'Basic abc',
      'Bearer',
      'Bearer\tabc',
      ' Bearer abc',
      'Bearer abc ',
      'Bearer abc, Bearer def',
      'Bearer abc$'
    ]) {
      expect(parseBearerAuthorization(authorization)).toEqual({
        ok: false,
        reason: 'malformed'
      })
    }
    expect(parseBearerAuthorization(null)).toEqual({
      ok: false,
      reason: 'missing'
    })
  })

  test('builds a deterministic, safely quoted challenge', () => {
    expect(
      buildBearerChallenge({
        resourceMetadata: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
        error: 'insufficient_scope',
        errorDescription: 'Needs "write"',
        scope: ['tools:read', 'tools:write']
      })
    ).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="Needs \\"write\\"", scope="tools:read tools:write"'
    )
  })
})

describe('resource-server enforcement', () => {
  const resource = 'https://mcp.example.com/mcp'

  test('filters and identifies missing scopes deterministically', () => {
    expect(
      filterAuthorizedScopes(
        ['tools:write', 'tools:read', 'tools:write'],
        ['tools:read tools:write']
      )
    ).toEqual(['tools:write', 'tools:read'])
    expect(missingRequiredScopes(['tools:read', 'tools:write'], ['tools:read'])).toEqual([
      'tools:write'
    ])
  })

  test('rejects invalid clock skew in direct authorization helpers', async () => {
    for (const clockSkewSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => isPrincipalExpired({ expiresAt: 100 }, 0, clockSkewSeconds)).toThrow(
        'clockSkewSeconds'
      )
      await expect(
        authorizeBearerRequest(
          new Request(resource, { headers: { Authorization: 'Bearer opaque' } }),
          {
            resource,
            verifier: async () => {
              throw new Error('must not run')
            },
            clockSkewSeconds
          }
        )
      ).rejects.toThrow('clockSkewSeconds')
    }
  })

  test('rejects invalid verifier clock values', async () => {
    expect(() => isPrincipalExpired({ expiresAt: 100 }, Number.NaN)).toThrow('nowSeconds')
    for (const now of [() => Number.NaN, () => Number.NEGATIVE_INFINITY]) {
      await expect(
        authorizeBearerRequest(
          new Request(resource, { headers: { Authorization: 'Bearer opaque' } }),
          {
            resource,
            verifier: async () => ({
              tokenType: 'access_token',
              subject: 'user',
              audience: resource,
              scopes: [],
              expiresAt: 1
            }),
            now
          }
        )
      ).rejects.toThrow('finite timestamp')
    }
  })

  test('preserves the exact token through verifier and request context', async () => {
    const token = 'Opaque.Token+Value=='
    let receivedToken: string | undefined
    const request = new Request(resource, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const result = await authorizeBearerRequest(request, {
      resource,
      requiredScopes: ['tools:read'],
      now: () => 1_000_000,
      verifier: (candidate, context) => {
        receivedToken = candidate
        expect(context.request).toBe(request)
        expect(context.resource).toBe(resource)
        return {
          tokenType: 'access_token',
          subject: 'user-1',
          audience: [resource],
          expiresAt: 2_000,
          scopes: ['tools:read']
        }
      }
    })

    expect(receivedToken).toBe(token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.authorization).not.toHaveProperty('token')
      expect(result.authorization.principal.subject).toBe('user-1')
      expect(result.authorization.scopes).toEqual(['tools:read'])
    }
  })

  test('returns a 401 challenge for a missing or rejected token', async () => {
    const missing = await authorizeBearerRequest(new Request(resource), {
      resource,
      verifier: () => {
        throw new Error('must not run')
      }
    })
    expect(missing).toMatchObject({
      ok: false,
      status: 401,
      error: 'invalid_token'
    })

    const rejected = await authorizeBearerRequest(
      new Request(resource, {
        headers: { Authorization: 'Bearer opaque' }
      }),
      {
        resource,
        verifier: () => {
          throw new Error('not valid')
        }
      }
    )
    expect(rejected).toMatchObject({
      ok: false,
      status: 401,
      error: 'invalid_token'
    })
  })

  test('enforces audience, expiry, and scopes', async () => {
    const request = new Request(resource, {
      headers: { Authorization: 'Bearer opaque' }
    })
    const principal = {
      tokenType: 'access_token' as const,
      subject: 'client-1',
      audience: 'https://different.example/mcp',
      expiresAt: 1_001,
      scopes: ['tools:read']
    }

    const wrongAudience = await authorizeBearerRequest(request, {
      resource,
      now: () => 1_000_000,
      verifier: () => principal
    })
    expect(wrongAudience).toMatchObject({
      ok: false,
      status: 401,
      error: 'invalid_token'
    })

    const expired = await authorizeBearerRequest(request, {
      resource,
      now: () => 1_001_000,
      verifier: () => ({ ...principal, audience: resource })
    })
    expect(expired).toMatchObject({
      ok: false,
      status: 401,
      error: 'invalid_token'
    })

    const insufficient = await authorizeBearerRequest(request, {
      resource,
      requiredScopes: ['tools:write'],
      now: () => 1_000_000,
      verifier: () => ({ ...principal, audience: resource })
    })
    expect(insufficient).toMatchObject({
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      missingScopes: ['tools:write']
    })
  })

  test('rejects ID tokens, ID-JAGs, and raw SAML assertions as MCP credentials', async () => {
    for (const tokenType of ['id_token', 'id-jag', 'saml_assertion']) {
      const result = await authorizeBearerRequest(
        new Request(resource, { headers: { Authorization: `Bearer direct-${tokenType}` } }),
        {
          resource,
          verifier: () =>
            ({
              tokenType,
              subject: 'enterprise-user',
              audience: resource,
              expiresAt: Math.floor(Date.now() / 1000) + 60,
              scopes: ['tools:read']
            }) as never
        }
      )

      expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' })
    }
  })
})
