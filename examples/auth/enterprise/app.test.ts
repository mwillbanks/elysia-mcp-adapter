import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  createEnterpriseExample,
  enterpriseMcpCall,
  issueEnterpriseAccessToken,
  SAML_PROVIDER_ID,
  TEST_IDP_ENTRY_POINT
} from './app.js'
import { createEphemeralIdpCertificate } from './test-certificate.js'

describe('Better Auth enterprise SAML boundary to OAuth MCP token', () => {
  let example: Awaited<ReturnType<typeof createEnterpriseExample>>

  beforeAll(async () => {
    example = await createEnterpriseExample({
      secret: crypto.randomUUID().repeat(2),
      samlCertificate: await createEphemeralIdpCertificate()
    })
    example.app.listen(43102)
  })

  afterAll(() => {
    example.app.stop()
    example.database.close()
  })

  test('routes SAML sign-in through the configured deterministic IdP boundary', async () => {
    const metadata = await example.app.handle(
      new Request(
        `http://localhost:43102/api/auth/sso/saml2/sp/metadata?providerId=${SAML_PROVIDER_ID}`
      )
    )
    expect(metadata.status).toBe(200)
    expect(metadata.headers.get('content-type')).toContain('application/xml')
    expect(await metadata.text()).toContain(`/sso/saml2/sp/acs/${SAML_PROVIDER_ID}`)

    const signIn = await example.auth.api.signInSSO({
      body: {
        providerId: SAML_PROVIDER_ID,
        providerType: 'saml',
        callbackURL: '/after-sso'
      }
    })
    const redirect = new URL(signIn.url)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(TEST_IDP_ENTRY_POINT)
    expect(redirect.searchParams.get('SAMLRequest')).toBeString()

    const idp = await example.app.handle(new Request(redirect))
    expect(idp.status).toBe(501)
    expect(await idp.json()).toMatchObject({ error: 'test_idp_has_no_login_ui' })
  })

  test('fails closed at ACS for an unsigned, uncorrelated assertion', async () => {
    const response = await example.app.handle(
      new Request(`http://localhost:43102/api/auth/sso/saml2/sp/acs/${SAML_PROVIDER_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SAMLResponse: Buffer.from('<Assertion ID="unsigned"/>').toString('base64')
        })
      })
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('error=')
  })

  test('uses a final OAuth access token at MCP', async () => {
    const token = await issueEnterpriseAccessToken(example)
    const response = await enterpriseMcpCall(example.app, token.access_token)
    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(body.result.structuredContent.clientId).toBeString()
    expect(body.result.structuredContent.scopes).toContain('mcp:read')

    const discovery = await example.app.handle(
      new Request('http://127.0.0.1:43102/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.access_token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-method': 'server/discover',
          'mcp-protocol-version': '2026-07-28'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        })
      })
    )
    expect(discovery.status).toBe(200)
    expect((await discovery.json()) as any).toMatchObject({
      result: {
        capabilities: {
          extensions: {
            'io.modelcontextprotocol/enterprise-managed-authorization': {}
          }
        }
      }
    })
  })

  test('rejects direct SAML assertions and ID-JAGs at the MCP bearer boundary', async () => {
    const saml = Buffer.from('<Assertion ID="not-an-access-token"/>').toString('base64')
    for (const invalidCredential of [saml, 'id-jag.test.enterprise-assertion']) {
      const response = await enterpriseMcpCall(example.app, invalidCredential)
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toContain('invalid_token')
    }
  })
})
