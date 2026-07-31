import { Database } from 'bun:sqlite'
import { oauthProvider } from '@better-auth/oauth-provider'
import { sso } from '@better-auth/sso'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { verifyAccessToken } from 'better-auth/oauth2'
import { jwt } from 'better-auth/plugins'
import { Elysia } from 'elysia'
import { type McpAuthPrincipal, mcp } from '../../../src/index.js'

const ENTERPRISE_BASE_URL = 'http://localhost:43102/api/auth'
const ENTERPRISE_RESOURCE = 'http://localhost:43102/mcp'
export const TEST_IDP_ENTRY_POINT = 'http://localhost:43102/test-idp/sso'
export const SAML_PROVIDER_ID = 'example-saml'

export interface EnterpriseExampleOptions {
  database?: Database
  secret?: string
  samlCertificate?: string
}

function requireConfiguration(options: EnterpriseExampleOptions) {
  const secret = options.secret ?? process.env.BETTER_AUTH_SECRET
  const samlCertificate = options.samlCertificate ?? process.env.SAML_IDP_CERT
  if (!secret || secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters')
  }
  if (!samlCertificate?.includes('BEGIN CERTIFICATE')) {
    throw new Error('SAML_IDP_CERT must be a PEM encoded certificate')
  }
  return { secret, samlCertificate }
}

export async function createEnterpriseExample(options: EnterpriseExampleOptions = {}) {
  const { secret, samlCertificate } = requireConfiguration(options)
  const database = options.database ?? new Database(':memory:')
  const authOptions = {
    appName: 'Elysia MCP enterprise example',
    baseURL: ENTERPRISE_BASE_URL,
    secret,
    database,
    // Used only to create the local OAuth client owner in tests/smoke.
    // Enterprise end-user authentication remains on the SAML SSO path.
    emailAndPassword: { enabled: true },
    plugins: [
      sso({
        defaultSSO: [
          {
            providerId: SAML_PROVIDER_ID,
            domain: 'example.local',
            samlConfig: {
              issuer: `${ENTERPRISE_BASE_URL}/sso/saml2/sp/metadata`,
              entryPoint: TEST_IDP_ENTRY_POINT,
              cert: samlCertificate,
              callbackUrl: `${ENTERPRISE_BASE_URL}/sso/saml2/sp/acs/${SAML_PROVIDER_ID}`,
              audience: ENTERPRISE_BASE_URL,
              idpMetadata: {
                entityID: 'http://localhost:43102/test-idp',
                cert: samlCertificate,
                singleSignOnService: [
                  {
                    Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
                    Location: TEST_IDP_ENTRY_POINT
                  }
                ]
              },
              spMetadata: { entityID: ENTERPRISE_BASE_URL, binding: 'redirect' },
              wantAssertionsSigned: true,
              authnRequestsSigned: false,
              signatureAlgorithm: 'sha256',
              digestAlgorithm: 'sha256'
            }
          }
        ],
        saml: {
          enableInResponseToValidation: true,
          allowIdpInitiated: false,
          requireTimestamps: true,
          algorithms: { onDeprecated: 'reject' },
          maxResponseSize: 256 * 1024,
          maxMetadataSize: 100 * 1024
        }
      }),
      jwt(),
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',
        silenceWarnings: { oauthAuthServerConfig: true },
        scopes: ['mcp:read'],
        validAudiences: [ENTERPRISE_RESOURCE],
        clientCredentialGrantDefaultScopes: ['mcp:read'],
        customAccessTokenClaims: ({ resource }) => ({
          'https://example.local/token-kind': 'access_token',
          resource
        })
      })
    ]
  }

  await (await getMigrations(authOptions)).runMigrations()
  const auth = betterAuth(authOptions)

  const verifyForMcp = async (token: string): Promise<McpAuthPrincipal> => {
    const payload = await verifyAccessToken(token, {
      jwksUrl: `${ENTERPRISE_BASE_URL}/jwks`,
      verifyOptions: { issuer: ENTERPRISE_BASE_URL, audience: ENTERPRISE_RESOURCE },
      scopes: ['mcp:read']
    })
    if (payload['https://example.local/token-kind'] !== 'access_token' || !payload.exp) {
      throw new Error('SAML assertions, ID tokens, and ID-JAGs are not MCP access tokens')
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : []
    return {
      tokenType: 'access_token',
      subject: payload.sub,
      issuer: payload.iss,
      audience: payload.aud ?? [],
      expiresAt: payload.exp,
      scopes,
      clientId: typeof payload.client_id === 'string' ? payload.client_id : undefined
    }
  }

  const app = new Elysia()
    .use(
      mcp({
        allowedRoutes: [],
        extensions: {
          auth: {
            resource: ENTERPRISE_RESOURCE,
            authorizationServers: [ENTERPRISE_BASE_URL],
            scopes: ['mcp:read'],
            profiles: { enterpriseManaged: true, clientCredentials: true },
            verifyAccessToken: verifyForMcp
          }
        }
      })
    )
    .get('/.well-known/oauth-authorization-server/api/auth', ({ request }) => auth.handler(request))
    .get('/test-idp/sso', ({ query, set }) => {
      if (typeof query.SAMLRequest !== 'string' || query.SAMLRequest.length === 0) {
        set.status = 400
        return { error: 'missing_saml_request' }
      }
      set.status = 501
      return {
        error: 'test_idp_has_no_login_ui',
        boundary: 'The AuthnRequest reached the configured local IdP endpoint.'
      }
    })
    .all('/api/auth/*', ({ request }) => auth.handler(request))
    .mcpTool('enterprise.principal', (_input, context) => ({
      subject: context.authorization?.principal.subject,
      clientId: context.authorization?.principal.clientId,
      scopes: context.authorization?.scopes
    }))

  return { app, auth, database, verifyForMcp }
}

export async function issueEnterpriseAccessToken(
  example: Awaited<ReturnType<typeof createEnterpriseExample>>,
  ownerCookie?: string
) {
  if (!ownerCookie) {
    const owner = await example.auth.api.signUpEmail({
      body: {
        name: 'Enterprise Client Owner',
        email: `${crypto.randomUUID()}@example.local`,
        password: 'correct horse battery staple'
      },
      returnHeaders: true
    })
    ownerCookie = owner.headers.get('set-cookie') ?? ''
  }
  const client = await example.auth.api.adminCreateOAuthClient({
    headers: new Headers({ cookie: ownerCookie }),
    body: {
      client_name: 'Enterprise MCP workload',
      redirect_uris: ['http://localhost:43102/callback'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['client_credentials'],
      response_types: ['code'],
      type: 'web',
      scope: 'mcp:read'
    }
  })
  const response = await example.app.handle(
    new Request(`${ENTERPRISE_BASE_URL}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: client.client_id,
        client_secret: client.client_secret ?? '',
        scope: 'mcp:read',
        resource: ENTERPRISE_RESOURCE
      })
    })
  )
  if (!response.ok) throw new Error(`enterprise token issuance failed: ${await response.text()}`)
  return (await response.json()) as { access_token: string }
}

export async function enterpriseMcpCall(
  app: { handle(request: Request): Response | Promise<Response> },
  token: string
) {
  return app.handle(
    new Request(ENTERPRISE_RESOURCE, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'enterprise.principal'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'enterprise.principal',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    })
  )
}
