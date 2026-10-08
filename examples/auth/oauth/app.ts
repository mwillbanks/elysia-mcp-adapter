import { Database } from 'bun:sqlite'
import { mcp } from '@mwillbanks/elysia-mcp-adapter'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { jwt } from 'better-auth/plugins'
import { Elysia } from 'elysia'
import { exampleAccessTokenVerifier, exampleOAuthProvider } from '../access-tokens.js'

export const OAUTH_BASE_URL = 'http://localhost:43101/api/auth'
export const MCP_RESOURCE = 'http://localhost:43101/mcp'
const MCP_SCOPES = ['mcp:read', 'mcp:admin'] as const

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
    plugins: [jwt(), exampleOAuthProvider(MCP_RESOURCE, [...MCP_SCOPES])]
  }

  await (await getMigrations(options)).runMigrations()
  const auth = betterAuth(options)

  const verifyForMcp = exampleAccessTokenVerifier({
    issuer: OAUTH_BASE_URL,
    resource: MCP_RESOURCE,
    invalidTokenMessage: 'Bearer value is not an access token',
    acceptArrayScopes: true,
    includeGrantType: true
  })

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
      redirect_uris: [
        options.publicClient ? 'http://localhost:43101/callback' : 'https://client.example/callback'
      ],
      token_endpoint_auth_method: options.publicClient ? 'none' : 'client_secret_post',
      grant_types: options.publicClient ? ['authorization_code'] : ['client_credentials'],
      client_credentials_scopes: options.publicClient
        ? undefined
        : (options.scopes ?? [...MCP_SCOPES]),
      response_types: options.publicClient ? ['code'] : undefined,
      application_type: options.publicClient ? 'native' : 'web',
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
        accept: 'application/json, text/event-stream',
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
            'io.modelcontextprotocol/clientInfo': { name: 'oauth-example', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    })
  )
}
