import { createHash } from 'node:crypto'
import type { Elysia } from 'elysia'
import {
  buildProtectedResourceMetadata,
  protectedResourceMetadataPaths
} from './extensions/auth/index.js'
import { recoverWebhookSubscriptions } from './extensions/events/index.js'
import { MCP_SERVER_CARD_MIME_TYPE } from './extensions/server-card/index.js'
import { installMcpMethods } from './methods/install.js'
import { normalizeOptions } from './options.js'
import { ensureMcpState } from './state.js'
import { handleMcpHttpRequest } from './transport/json-rpc.js'
import type { AnyElysiaApp, McpPluginOptions, McpRouteOptions } from './types.js'

export function mcp(options: McpPluginOptions = {}) {
  const normalized = normalizeOptions(options)

  return function elysiaMcpAdapter<T extends AnyElysiaApp>(app: T) {
    ensureMcpState(app)
    installMcpMethods(app)

    const withMacro = app.macro({
      mcp: (_options: McpRouteOptions) => ({})
    })

    let configured: any = withMacro
    const serverCard = normalized.extensions.serverCard
    if (serverCard) {
      const body = JSON.stringify(serverCard.card)
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`
      configured = configured.get(
        `${normalized.path}/server-card`,
        ({ request, set }: any) => {
          set.headers['access-control-allow-origin'] = '*'
          set.headers['access-control-allow-methods'] = 'GET'
          set.headers['access-control-allow-headers'] = 'Content-Type, If-None-Match'
          set.headers['access-control-expose-headers'] = 'ETag'
          set.headers['cache-control'] = `public, max-age=${serverCard.maxAgeSeconds}`
          set.headers.etag = etag
          set.headers['content-type'] = MCP_SERVER_CARD_MIME_TYPE
          if (request.headers.get('if-none-match') === etag) {
            set.status = 304
            return undefined
          }
          return serverCard.card
        },
        { mcp: false, detail: { hide: true, tags: ['MCP'], summary: 'MCP Server Card' } }
      )
    }
    const auth = normalized.extensions.auth
    if (auth) {
      const metadata = buildProtectedResourceMetadata({
        resource: auth.resource,
        authorizationServers: auth.authorizationServers,
        ...auth.metadata,
        scopesSupported: auth.metadata?.scopesSupported ?? auth.scopes,
        bearerMethodsSupported: auth.metadata?.bearerMethodsSupported ?? ['header']
      })
      for (const path of protectedResourceMetadataPaths(auth.resource, auth.rootMetadataAlias)) {
        configured = configured.get(path, () => metadata, {
          mcp: false,
          detail: {
            hide: true,
            tags: ['OAuth'],
            summary: 'OAuth Protected Resource Metadata'
          }
        })
      }
    }

    recoverWebhookSubscriptions(configured as AnyElysiaApp, normalized)

    return configured.all(
      normalized.path,
      (context: any) =>
        handleMcpHttpRequest(configured as AnyElysiaApp, context.request, normalized),
      {
        mcp: false,
        parse: 'none',
        detail: {
          hide: true,
          tags: ['MCP'],
          summary: 'Model Context Protocol endpoint'
        }
      }
    )
  }
}

export function withMcpMethods() {
  return function elysiaMcpMethods<T extends Elysia<any, any, any, any, any, any, any>>(app: T): T {
    ensureMcpState(app as AnyElysiaApp)
    installMcpMethods(app as AnyElysiaApp)
    return app
  }
}
