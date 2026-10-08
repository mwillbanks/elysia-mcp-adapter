import {
  executeInterceptorChain,
  LEGACY_PROTOCOL_VERSION,
  MCP_ACTION_METADATA_ID,
  MCP_SERVER_CARD_REVISION,
  MCP_SERVER_CARD_SCHEMA,
  MCP_SERVER_VARIANTS_REVISION,
  MCP_TRUST_ANNOTATIONS_ID,
  type McpInterceptorRegistration,
  type McpServerNotification,
  mcp
} from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'

export const cardApp = new Elysia().use(
  mcp({
    allowedRoutes: [],
    server: { name: 'com.example/experimental', version: 'build-2026.10' },
    extensions: {
      serverCard: {
        version: MCP_SERVER_CARD_REVISION,
        environment: 'development',
        card: {
          $schema: MCP_SERVER_CARD_SCHEMA,
          name: 'com.example/experimental',
          description: 'Local experimental extension examples',
          version: 'build-2026.10',
          remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }]
        }
      }
    }
  })
)

const interceptorAppBase = new Elysia().use(
  mcp({ allowedRoutes: [], extensions: { interceptors: {} } })
)
export const interceptorApp = interceptorAppBase
  .mcpInterceptor(
    {
      name: 'trim-name',
      version: '1',
      description: 'Trims tool names before validation',
      type: 'mutation',
      priorityHint: -10,
      hooks: [{ events: ['tools/call'], phase: 'request' }]
    },
    ({ payload }) => ({
      modified: true,
      payload: { ...(payload as object), name: String((payload as any).name).trim() }
    })
  )
  .mcpInterceptor(
    {
      name: 'require-name',
      version: '1',
      description: 'Requires a tool name',
      type: 'validation',
      hooks: [{ events: ['tools/call'], phase: 'request' }]
    },
    ({ payload }) => ({ valid: Boolean((payload as any).name), severity: 'error' })
  )

function interceptorEntries(): McpInterceptorRegistration[] {
  return [
    {
      definition: {
        name: 'ordered',
        version: '1',
        description: 'Adds an ordered marker',
        type: 'mutation',
        priorityHint: 1,
        hooks: [{ events: ['tools/call'], phase: 'request' }]
      },
      handler: ({ payload }) => ({ modified: true, payload: [...(payload as string[]), 'ordered'] })
    },
    {
      definition: {
        name: 'audit-only',
        version: '1',
        description: 'Records a shadow mutation',
        type: 'mutation',
        mode: 'audit',
        hooks: [{ events: ['tools/call'], phase: 'request' }]
      },
      handler: () => ({ modified: true, payload: ['shadow'] })
    },
    {
      definition: {
        name: 'audit-failure',
        version: '1',
        description: 'Makes audit failures observable without blocking',
        type: 'validation',
        mode: 'audit',
        hooks: [{ events: ['tools/call'], phase: 'request' }]
      },
      handler: () => {
        throw new Error('audit unavailable')
      }
    }
  ]
}

function directionEntries(observations: string[]): McpInterceptorRegistration[] {
  return [
    {
      definition: {
        name: 'add-marker',
        version: '1',
        description: 'Adds a marker',
        type: 'mutation',
        hooks: [{ events: ['tools/call'], phase: 'request' }]
      },
      handler: ({ payload }) => ({
        modified: true,
        payload: { ...(payload as object), marker: 'added' }
      })
    },
    {
      definition: {
        name: 'observe-marker',
        version: '1',
        description: 'Records which payload the validator receives',
        type: 'validation',
        hooks: [{ events: ['tools/call'], phase: 'request' }]
      },
      handler: ({ payload }) => {
        observations.push('marker' in (payload as object) ? 'marked' : 'original')
        ;(payload as { leaked?: boolean }).leaked = true
        return { valid: false, severity: 'warn' }
      }
    },
    {
      definition: {
        name: 'confirm-isolation',
        version: '1',
        description: 'Confirms validators receive isolated payloads',
        type: 'validation',
        hooks: [{ events: ['tools/call'], phase: 'request' }]
      },
      handler: ({ payload }) => {
        observations.push('leaked' in (payload as object) ? 'leaked' : 'isolated')
        return { valid: true }
      }
    }
  ]
}

export async function runLocalInterceptorExamples() {
  const audit = await executeInterceptorChain(
    interceptorEntries().map((registration) => ({ registration })),
    'tools/call',
    'request',
    [],
    { request: new Request('http://localhost') },
    'sending'
  )
  const sendingObservations: string[] = []
  const sending = await executeInterceptorChain(
    directionEntries(sendingObservations).map((registration) => ({ registration })),
    'tools/call',
    'request',
    {},
    { request: new Request('http://localhost') },
    'sending'
  )
  const receivingObservations: string[] = []
  const receiving = await executeInterceptorChain(
    directionEntries(receivingObservations).map((registration) => ({ registration })),
    'tools/call',
    'request',
    {},
    { request: new Request('http://localhost') },
    'receiving'
  )
  return { audit, sending, sendingObservations, receiving, receivingObservations }
}

export function runBlockingInterceptorExample() {
  const registration: McpInterceptorRegistration = {
    definition: {
      name: 'block-dangerous',
      version: '1',
      description: 'Blocks an invalid payload with error severity',
      type: 'validation',
      hooks: [{ events: ['tools/call'], phase: 'request' }]
    },
    handler: () => ({ valid: false, severity: 'error' })
  }
  return executeInterceptorChain(
    [{ registration }],
    'tools/call',
    'request',
    {},
    { request: new Request('http://localhost') },
    'receiving'
  )
}

export const annotationApp = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool(
  'publish-report',
  () => ({
    content: [{ type: 'text' as const, text: 'published' }],
    _meta: {
      [MCP_TRUST_ANNOTATIONS_ID]: {
        sensitive: false,
        evidenceRef: {
          type: 'application/json',
          digest: 'sha256:example',
          canonicalization: 'jcs/rfc8785',
          ref: 'urn:example:evidence:1'
        }
      }
    }
  }),
  {
    annotations: {
      [MCP_ACTION_METADATA_ID]: {
        inputMetadata: { destination: 'external-service', sensitivity: 'internal' },
        returnMetadata: { source: 'report-service', sensitivity: 'public' },
        outcome: 'consequential',
        requiresReview: true
      }
    }
  }
)

let subscriptionClosed = false
function resourceChanges(): AsyncIterable<McpServerNotification> {
  return {
    [Symbol.asyncIterator]() {
      let finish: (() => void) | undefined
      return {
        next: () =>
          new Promise<IteratorResult<McpServerNotification>>((resolve) => {
            finish = () => resolve({ done: true, value: undefined })
          }),
        return: async () => {
          subscriptionClosed = true
          finish?.()
          return { done: true, value: undefined }
        }
      }
    }
  }
}
export function wasSubscriptionClosed() {
  return subscriptionClosed
}
export function resetSubscriptionState() {
  subscriptionClosed = false
}

export const variantApp = new Elysia()
  .use(
    mcp({
      allowedRoutes: [],
      transport: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        protocolVersions: [LEGACY_PROTOCOL_VERSION],
        enableGetSse: true,
        enableDeleteSession: true
      },
      extensions: {
        auth: {
          resource: 'https://example.com/mcp',
          authorizationServers: ['https://example.com'],
          verifyAccessToken: (token) => ({
            tokenType: 'access_token',
            subject: token,
            issuer: 'https://example.com',
            audience: 'https://example.com/mcp',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            scopes: []
          })
        },
        variants: {
          version: MCP_SERVER_VARIANTS_REVISION,
          discoveryLimit: 2,
          variants: [
            {
              id: 'full',
              description: 'All operations',
              status: 'stable',
              tools: ['shared', 'full-only'],
              resources: ['status://current']
            },
            { id: 'compact', description: 'Shared operations', status: 'stable', tools: ['shared'] }
          ]
        }
      },
      core: {
        pagination: {
          pageSize: 1,
          signingKey: 'experimental-example-signing-key-32-bytes'
        },
        subscriptions: { provider: { subscribe: resourceChanges }, resources: true }
      }
    })
  )
  .mcpTool('shared', () => 'shared')
  .mcpTool('full-only', () => 'full')
  .mcpResource('status://current', () => 'ready')
