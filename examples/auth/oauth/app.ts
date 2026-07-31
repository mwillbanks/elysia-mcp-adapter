import { Database } from 'bun:sqlite'
import { oauthProvider } from '@better-auth/oauth-provider'
import { type McpAuthPrincipal, mcp } from '@mwillbanks/elysia-mcp-adapter'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { verifyAccessToken } from 'better-auth/oauth2'
import { jwt } from 'better-auth/plugins'
import { Elysia } from 'elysia'

export const OAUTH_BASE_URL = 'http://localhost:43101/api/auth'
export const MCP_RESOURCE = 'http://localhost:43101/mcp'
const MCP_SCOPES = ['mcp:read', 'mcp:admin'] as const

function scopesFromClaim(scope: unknown): string[] {
  if (Array.isArray(scope))
    return scope.filter((value): value is string => typeof value === 'string')
  return typeof scope === 'string' ? scope.split(' ').filter(Boolean) : []
}

export async function createOAuthExample({
  database = new Database(':memory:'),
  secret = process.env.BETTER_AUTH_SECRET
}: {
  database?: Database
  secret?: string
} = {}) {
  if (!secret || secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters')
  }
  const options = {
    appName: 'Elysia MCP OAuth example',
    baseURL: OAUTH_BASE_URL,
    secret,
    database,
    emailAndPassword: { enabled: true },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',
        silenceWarnings: { oauthAuthServerConfig: true },
        scopes: [...MCP_SCOPES],
        validAudiences: [MCP_RESOURCE],
        clientCredentialGrantDefaultScopes: ['mcp:read'],
        customAccessTokenClaims: ({ resource }) => ({
          'https://example.local/token-kind': 'access_token',
          resource
        })
      })
    ]
  }

  await (await getMigrations(options)).runMigrations()
  const auth = betterAuth(options)

  const verifyForMcp = async (token: string): Promise<McpAuthPrincipal> => {
    const payload = await verifyAccessToken(token, {
      jwksUrl: `${OAUTH_BASE_URL}/jwks`,
      verifyOptions: { issuer: OAUTH_BASE_URL, audience: MCP_RESOURCE },
      scopes: ['mcp:read']
    })
    if (payload['https://example.local/token-kind'] !== 'access_token' || !payload.exp) {
      throw new Error('Bearer value is not an access token')
    }
    return {
      tokenType: 'access_token',
      subject: payload.sub,
      issuer: payload.iss,
      audience: payload.aud ?? [],
      expiresAt: payload.exp,
      scopes: scopesFromClaim(payload.scope),
      clientId: typeof payload.client_id === 'string' ? payload.client_id : undefined,
      claims: { grantType: payload.gty }
    }
  }

  const app = new Elysia()
    .use(
      mcp({
        allowedRoutes: [],
        extensions: {
          auth: {
            resource: MCP_RESOURCE,
            authorizationServers: [OAUTH_BASE_URL],
            scopes: ['mcp:read'],
            metadata: { scopesSupported: [...MCP_SCOPES] },
            profiles: { clientCredentials: true },
            verifyAccessToken: verifyForMcp
          }
        }
      })
    )
    .get('/.well-known/oauth-authorization-server/api/auth', ({ request }) => auth.handler(request))
    .all('/api/auth/*', ({ request }) => auth.handler(request))
    .mcpTool('principal.current', (_input, context) => ({
      subject: context.authorization?.principal.subject,
      clientId: context.authorization?.principal.clientId,
      scopes: context.authorization?.scopes
    }))
    .mcpTool('principal.admin', () => ({ ok: true }), {
      authorization: { requiredScopes: ['mcp:admin'] }
    })

  return { app, auth, database, verifyForMcp }
}

export async function createOAuthClient(
  auth: Awaited<ReturnType<typeof createOAuthExample>>['auth'],
  options: { publicClient?: boolean; scopes?: string[] } = {}
) {
  const owner = await auth.api.signUpEmail({
    body: {
      name: options.publicClient ? 'PKCE User' : 'M2M Client Owner',
      email: `${crypto.randomUUID()}@example.local`,
      password: 'correct horse battery staple'
    },
    returnHeaders: true
  })
  const ownerCookie = owner.headers.get('set-cookie') ?? ''
  const client = await auth.api.adminCreateOAuthClient({
    headers: new Headers({ cookie: ownerCookie }),
    body: {
      client_name: options.publicClient ? 'PKCE MCP client' : 'M2M MCP client',
      redirect_uris: ['http://localhost:43101/callback'],
      token_endpoint_auth_method: options.publicClient ? 'none' : 'client_secret_post',
      grant_types: options.publicClient ? ['authorization_code'] : ['client_credentials'],
      response_types: ['code'],
      type: options.publicClient ? 'native' : 'web',
      require_pkce: options.publicClient,
      skip_consent: true,
      scope: (options.scopes ?? [...MCP_SCOPES]).join(' ')
    }
  })
  return { ...client, ownerCookie }
}

export async function mcpCall(
  app: { handle(request: Request): Response | Promise<Response> },
  token: string,
  name = 'principal.current'
) {
  return app.handle(
    new Request(MCP_RESOURCE, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': name
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
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
