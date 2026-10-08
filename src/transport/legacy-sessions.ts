import type { McpAuthorizationContext } from '../extensions/auth/index.js'
import { attachEventSessionStream, deleteEventSession } from '../extensions/events/index.js'
import type { AnyElysiaApp, JsonRpcResponse, NormalizedMcpPluginOptions } from '../types.js'
import { variantPrincipal } from './variant-selection.js'
import { type VariantSession, variantSessions } from './variant-subscriptions.js'

export interface LegacySessionRuntime {
  errorResponse: (
    id: string | number | null | undefined,
    code: number,
    message: string,
    data?: unknown
  ) => JsonRpcResponse
  jsonResponse: (body: unknown, status?: number) => Response
}

function unknownSession(runtime: LegacySessionRuntime): Response {
  return runtime.jsonResponse(runtime.errorResponse(null, -32602, 'Unknown MCP session'), 400)
}

function variantSessionForRequest(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  runtime: LegacySessionRuntime
): VariantSession | undefined | Response {
  const sessionId = request.headers.get('mcp-session-id')
  const session = sessionId ? variantSessions(app, options).get(sessionId) : undefined
  if (!options.extensions.variants) return session
  if (session?.principal === variantPrincipal(authorization)) return session
  return unknownSession(runtime)
}

function closeLegacyStream(
  session: VariantSession | undefined,
  controller: ReadableStreamDefaultController<Uint8Array>,
  heartbeat: ReturnType<typeof setInterval> | undefined,
  detachEvents: (() => void) | undefined
): void {
  if (heartbeat) clearInterval(heartbeat)
  session?.streams.delete(controller)
  detachEvents?.()
  try {
    controller.close()
  } catch {
    // The consumer may have already cancelled the stream.
  }
}

function legacyStream(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  session: VariantSession | undefined
): ReadableStream<Uint8Array> {
  const sessionId = request.headers.get('mcp-session-id')
  const principal = variantPrincipal(authorization)
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array>
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let detachEvents: (() => void) | undefined
  const close = () => closeLegacyStream(session, controller, heartbeat, detachEvents)
  return new ReadableStream<Uint8Array>({
    start(stream) {
      controller = stream
      heartbeat = setInterval(
        () => stream.enqueue(encoder.encode(': heartbeat\n\n')),
        options.core.subscriptions?.heartbeatMs ?? 15_000
      )
      session?.streams.set(stream, heartbeat)
      detachEvents = sessionId
        ? attachEventSessionStream(app, sessionId, principal, stream, close, options)
        : undefined
      if (options.extensions.events && !detachEvents) {
        clearInterval(heartbeat)
        stream.error(new Error('Unknown MCP event session'))
        return
      }
      stream.enqueue(encoder.encode(': connected\n\n'))
      if (request.signal.aborted) close()
      else request.signal.addEventListener('abort', close, { once: true })
    },
    cancel: close
  })
}

function legacySseResponse(body: ReadableStream<Uint8Array>, sessionId: string | null): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    }
  })
}

function emptySseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
  return legacySseResponse(body, null)
}

function methodDisabled(): Response {
  return new Response(null, { status: 405, headers: { allow: 'POST, GET, DELETE' } })
}

function handleLegacyGet(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  runtime: LegacySessionRuntime
): Response {
  if (!options.transport.enableGetSse) return methodDisabled()
  if (!options.extensions.variants && !options.extensions.events) return emptySseResponse()
  const session = variantSessionForRequest(app, request, options, authorization, runtime)
  if (session instanceof Response) return session
  return legacySseResponse(
    legacyStream(app, request, options, authorization, session),
    request.headers.get('mcp-session-id')
  )
}

async function closeVariantSession(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  runtime: LegacySessionRuntime
): Promise<Response | undefined> {
  if (!options.extensions.variants) return undefined
  const sessionId = request.headers.get('mcp-session-id')
  const session = variantSessionForRequest(app, request, options, authorization, runtime)
  if (session instanceof Response) return session
  if (!session || !sessionId) return unknownSession(runtime)
  for (const [controller, heartbeat] of session.streams) {
    clearInterval(heartbeat)
    controller.close()
  }
  session.streams.clear()
  await Promise.allSettled([...session.subscriptions.values()].map(({ close }) => close?.()))
  variantSessions(app, options).delete(sessionId)
  return undefined
}

async function handleLegacyDelete(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  runtime: LegacySessionRuntime
): Promise<Response> {
  if (!options.transport.enableDeleteSession) return methodDisabled()
  const variantFailure = await closeVariantSession(app, request, options, authorization, runtime)
  if (variantFailure) return variantFailure
  if (options.extensions.events) {
    const sessionId = request.headers.get('mcp-session-id')
    const deleted =
      sessionId && deleteEventSession(app, sessionId, variantPrincipal(authorization), options)
    if (!deleted) return unknownSession(runtime)
  }
  return new Response(null, { status: 202 })
}

export function handleLegacyAuxiliaryMethod(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  runtime: LegacySessionRuntime
): Promise<Response> | Response {
  return request.method === 'GET'
    ? handleLegacyGet(app, request, options, authorization, runtime)
    : handleLegacyDelete(app, request, options, authorization, runtime)
}
