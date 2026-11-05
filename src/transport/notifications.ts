import type { JsonRpcResponse } from '../types.js'
import { McpProtocolError } from './protocol-error.js'

const LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency'
] as const
const MAX_NOTIFICATIONS = 128
const MAX_NOTIFICATION_BYTES = 64 * 1024

export const MCP_LOG_LEVEL_META_KEY = 'io.modelcontextprotocol/logLevel'

export type McpLogLevel = (typeof LOG_LEVELS)[number]

export interface McpInvocationNotify {
  progress(value: number, detail?: { total?: number; message?: string }): void
  message(data: unknown, options?: { level?: McpLogLevel; logger?: string }): void
}

export const silentNotify: McpInvocationNotify = Object.freeze({
  progress() {},
  message() {}
})

export interface RequestNotificationChannels {
  progressToken?: string | number
  logLevel?: McpLogLevel
}

function isLogLevel(value: unknown): value is McpLogLevel {
  return typeof value === 'string' && LOG_LEVELS.includes(value as McpLogLevel)
}

export function requestLogLevel(value: unknown): McpLogLevel | undefined {
  if (value === undefined || isLogLevel(value)) return value
  throw new McpProtocolError(-32602, 'Invalid MCP log level', 400)
}

function serializeNotification(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params }, function (key, value: unknown) {
    if (key === 'data' && this === params && isOmittedJsonValue(value)) {
      throw new TypeError('MCP log message data must be JSON serializable')
    }
    return value
  })
}

function isOmittedJsonValue(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

export function notificationBody(
  requestSignal: AbortSignal,
  channels: RequestNotificationChannels,
  dispatch: (
    signal: AbortSignal,
    notify: McpInvocationNotify
  ) => Promise<JsonRpcResponse | undefined>,
  onError: (error: unknown) => JsonRpcResponse,
  onReady: () => void
): ReadableStream<Uint8Array> {
  const abort = new AbortController()
  const encoder = new TextEncoder()
  let closed = false
  let finishing = false
  let lastProgress = Number.NEGATIVE_INFINITY
  let count = 0
  let bytes = 0
  let stop: () => void

  return new ReadableStream({
    start(controller) {
      const encode = (json: string) => encoder.encode(`event: message\ndata: ${json}\n\n`)
      const close = () => {
        if (closed) return
        closed = true
        requestSignal.removeEventListener('abort', stop)
        controller.close()
      }
      stop = () => {
        abort.abort(requestSignal.reason)
        close()
        onReady()
      }
      if (requestSignal.aborted) {
        stop()
        return
      }
      requestSignal.addEventListener('abort', stop, { once: true })

      const inactive = () => closed || finishing || abort.signal.aborted
      const send = (method: string, params: Record<string, unknown>) => {
        if (inactive() || count >= MAX_NOTIFICATIONS || bytes >= MAX_NOTIFICATION_BYTES) return
        let frame: Uint8Array
        try {
          frame = encode(serializeNotification(method, params))
        } catch {
          return
        }
        if (
          inactive() ||
          count >= MAX_NOTIFICATIONS ||
          bytes + frame.byteLength > MAX_NOTIFICATION_BYTES
        )
          return
        count++
        bytes += frame.byteLength
        controller.enqueue(frame)
        onReady()
      }
      const notify: McpInvocationNotify = {
        progress(value, { total, message } = {}) {
          if (inactive() || channels.progressToken === undefined) return
          if (!Number.isFinite(value) || value <= lastProgress) {
            throw new TypeError('Progress values must be finite and strictly increasing')
          }
          if (total !== undefined && !Number.isFinite(total)) {
            throw new TypeError('Progress total must be finite')
          }
          lastProgress = value
          send('notifications/progress', {
            progressToken: channels.progressToken,
            progress: value,
            total,
            message
          })
        },
        message(data, { level = 'info', logger } = {}) {
          if (inactive() || channels.logLevel === undefined) return
          if (
            !isLogLevel(level) ||
            LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(channels.logLevel)
          )
            return
          if (data !== undefined) send('notifications/message', { level, logger, data })
        }
      }
      const sendTerminal = (response: JsonRpcResponse | undefined) => {
        finishing = true
        if (closed || !response) return
        const frame = encode(JSON.stringify(response))
        if (!closed) controller.enqueue(frame)
      }
      void dispatch(abort.signal, notify)
        .then((response) => {
          sendTerminal(response)
          close()
        })
        .catch((error) => {
          try {
            sendTerminal(onError(error))
          } finally {
            close()
            onReady()
          }
        })
    },
    cancel(reason) {
      closed = true
      abort.abort(reason ?? 'MCP response stream closed')
      requestSignal.removeEventListener('abort', stop)
    }
  })
}
