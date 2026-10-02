import {
  eventPrincipalKey,
  MCP_EVENTS_REVISION,
  type McpAuthorizationContext,
  mcp
} from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'
import { InMemoryEventHistory } from './event-source.js'
import { SqliteWebhookProvider } from './provider.js'

const exampleAuthorization: McpAuthorizationContext = {
  principal: {
    tokenType: 'access_token',
    subject: 'owner',
    issuer: 'https://auth.example.test',
    audience: 'https://example.test/mcp',
    expiresAt: 4_102_444_800,
    scopes: []
  },
  scopes: [],
  attributes: {}
}

export interface WebhookFixtureAuthentication {
  accessToken: string
  authorizeDelivery: (storedPrincipal: string, authorization: McpAuthorizationContext) => boolean
}

export function createWebhookEventApp(
  database: string,
  authentication: WebhookFixtureAuthentication
) {
  const expectedPrincipal = eventPrincipalKey(exampleAuthorization)
  if (!expectedPrincipal) throw new Error('Fixture authorization principal is unavailable')
  const provider = new SqliteWebhookProvider(database, (storedPrincipal) =>
    storedPrincipal === expectedPrincipal &&
    authentication.authorizeDelivery(storedPrincipal, exampleAuthorization)
      ? exampleAuthorization
      : false
  )
  const history = new InMemoryEventHistory(20)
  const app = new Elysia()
    .use(
      mcp({
        allowedRoutes: [],
        transport: { protocolVersions: ['2025-11-25'] },
        extensions: {
          auth: {
            version: '2025-11-25',
            resource: 'https://example.test/mcp',
            authorizationServers: ['https://auth.example.test'],
            verifyAccessToken: (token) => {
              if (token !== authentication.accessToken)
                throw new TypeError('Fixture access token is invalid')
              return exampleAuthorization.principal
            }
          },
          events: {
            version: MCP_EVENTS_REVISION,
            cursor: {
              signingKey: 'example-events-cursor-signing-key-at-least-32-bytes',
              ttlMs: 60_000
            },
            pollIntervalMs: 10,
            maxEvents: 10,
            webhook: {
              provider,
              defaultTtlMs: 60_000,
              minTtlMs: 30_000,
              maxTtlMs: 120_000,
              environment: 'development',
              allowPrivateAddresses: true,
              resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
              requestTimeoutMs: 500,
              retryBaseMs: 5,
              maxRetryElapsedMs: 500,
              verificationTtlMs: 1,
              secretRotationGraceMs: 60_000,
              maxSubscriptionsPerPrincipal: 2
            }
          }
        }
      })
    )
    .mcpEvent(
      {
        name: 'com.example.webhook',
        description: 'Durable webhook event',
        delivery: ['webhook'],
        inputSchema: { type: 'object', additionalProperties: false },
        payloadSchema: {
          type: 'object',
          properties: { sequence: { type: 'number' } },
          required: ['sequence'],
          additionalProperties: false
        }
      },
      history.handler(10)
    )
  return {
    app,
    provider,
    publishWebhookEvent: () => history.publish('com.example.webhook', { sequence: Date.now() })
  }
}
