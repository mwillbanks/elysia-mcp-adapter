import { randomUUID } from 'node:crypto'
import type { AnyElysiaApp, NormalizedMcpPluginOptions } from '../../types.js'

interface EventSession {
  principal?: string
  variant?: string
  streams: Map<ReadableStreamDefaultController<Uint8Array>, () => void>
}

interface AppEventSessions {
  defaultSessions: Map<string, EventSession>
  byOptions: WeakMap<NormalizedMcpPluginOptions, Map<string, EventSession>>
  all: Set<Map<string, EventSession>>
}

const EVENT_SESSIONS = new WeakMap<AnyElysiaApp, AppEventSessions>()

export function initializeEventSession(
  app: AnyElysiaApp,
  principal: string | undefined,
  variant: string | undefined,
  requestedId?: string,
  options?: NormalizedMcpPluginOptions
): string {
  const id = requestedId ?? randomUUID()
  sessions(app, options).set(id, { principal, variant, streams: new Map() })
  return id
}

export function attachEventSessionStream(
  app: AnyElysiaApp,
  id: string,
  principal: string | undefined,
  stream: ReadableStreamDefaultController<Uint8Array>,
  close: () => void = () => stream.close(),
  options?: NormalizedMcpPluginOptions
): (() => void) | undefined {
  const session = sessions(app, options).get(id)
  if (!session || session.principal !== principal) return undefined
  session.streams.set(stream, close)
  return () => session.streams.delete(stream)
}

export function deleteEventSession(
  app: AnyElysiaApp,
  id: string,
  principal: string | undefined,
  options?: NormalizedMcpPluginOptions
): boolean {
  const session = sessions(app, options).get(id)
  if (!session || session.principal !== principal) return false
  for (const close of session.streams.values()) {
    try {
      close()
    } catch {}
  }
  return sessions(app, options).delete(id)
}

export function eventSessionVariant(
  app: AnyElysiaApp,
  id: string,
  options?: NormalizedMcpPluginOptions
): string | undefined {
  return sessions(app, options).get(id)?.variant
}

export function notifyMcpEventListChanged(app: AnyElysiaApp): void {
  for (const configuredSessions of appSessions(app).all)
    for (const session of configuredSessions.values())
      for (const stream of session.streams.keys()) {
        try {
          const chunk = new TextEncoder().encode(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/events/list_changed',
              ...(session.variant
                ? {
                    params: {
                      _meta: { 'io.modelcontextprotocol/server-variant': session.variant }
                    }
                  }
                : {})
            })}\n\n`
          )
          stream.enqueue(chunk)
        } catch {
          session.streams.delete(stream)
        }
      }
}

function appSessions(app: AnyElysiaApp): AppEventSessions {
  let state = EVENT_SESSIONS.get(app)
  if (!state) {
    const defaultSessions = new Map<string, EventSession>()
    state = { defaultSessions, byOptions: new WeakMap(), all: new Set([defaultSessions]) }
    EVENT_SESSIONS.set(app, state)
  }
  return state
}

function sessions(
  app: AnyElysiaApp,
  options?: NormalizedMcpPluginOptions
): Map<string, EventSession> {
  const state = appSessions(app)
  if (!options) return state.defaultSessions
  let configured = state.byOptions.get(options)
  if (!configured) {
    configured = new Map()
    state.byOptions.set(options, configured)
    state.all.add(configured)
  }
  return configured
}
