import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createOAuthExample, MCP_RESOURCE, mcpCall, OAUTH_BASE_URL } from './app.js'
import { issueAuthorizationCodeToken, issueClientCredentialsToken } from './flows.js'

describe('Better Auth OAuth to MCP', () => {
  let example: Awaited<ReturnType<typeof createOAuthExample>>

  beforeAll(async () => {
    example = await createOAuthExample({ secret: crypto.randomUUID().repeat(2) })
    example.app.listen(43101)
  })

  afterAll(() => {
    example.app.stop()
    example.database.close()
  })

  test('publishes protected-resource metadata', async () => {
    const response = await example.app.handle(
      new Request('http://localhost:43101/.well-known/oauth-protected-resource/mcp')
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      resource: MCP_RESOURCE,
      authorization_servers: [OAUTH_BASE_URL],
      scopes_supported: ['mcp:read', 'mcp:admin']
    })

    const authorizationMetadata = await example.app.handle(
      new Request('http://localhost:43101/.well-known/oauth-authorization-server/api/auth')
    )
    expect(authorizationMetadata.status).toBe(200)
    expect(await authorizationMetadata.json()).toMatchObject({
      issuer: OAUTH_BASE_URL,
      grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token']
    })
  })

  test('executes authorization-code with S256 PKCE and calls MCP as a normalized user', async () => {
    const token = await issueAuthorizationCodeToken(example)
    const response = await mcpCall(example.app, token.access_token)
    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(body.result.content[0].text).toContain('subject')
  })

  test('issues and verifies client_credentials access tokens', async () => {
    const token = await issueClientCredentialsToken(example)
    const principal = await example.verifyForMcp(token.access_token)
    expect(principal).toMatchObject({ tokenType: 'access_token', audience: MCP_RESOURCE })
    expect(principal.clientId).toBeString()
    expect(principal.scopes).toContain('mcp:read')

    const response = await mcpCall(example.app, token.access_token)
    expect(response.status).toBe(200)
  })

  test('enforces scopes and rejects invalid tokens', async () => {
    const token = await issueClientCredentialsToken(example, ['mcp:read'])
    const denied = await mcpCall(example.app, token.access_token, 'principal.admin')
    expect(denied.status).toBe(403)
    expect(denied.headers.get('www-authenticate')).toContain('insufficient_scope')

    const invalid = await mcpCall(example.app, 'not-a-jwt')
    expect(invalid.status).toBe(401)
    expect(invalid.headers.get('www-authenticate')).toContain('invalid_token')
  })

  test('refuses token issuance for an unregistered audience', async () => {
    const client = await (await import('./app.js')).createOAuthClient(example.auth)
    const response = await example.app.handle(
      new Request(`${OAUTH_BASE_URL}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: client.client_id,
          client_secret: client.client_secret ?? '',
          scope: 'mcp:read',
          resource: 'https://wrong.example/mcp'
        })
      })
    )
    expect(response.status).toBe(400)
  })
})
