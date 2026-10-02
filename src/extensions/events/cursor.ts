import { createHmac, timingSafeEqual } from 'node:crypto'
import type { McpAuthorizationContext } from '../auth/index.js'
import type { McpEventCursorOptions } from './types.js'

interface EventCursorEnvelope {
  v: 1
  name: string
  argumentsHash: string
  principal?: string
  variant?: string
  exp: number
  cursor: string
}

export function encodeEventCursor(
  cursor: string | null,
  name: string,
  arguments_: Record<string, unknown>,
  authorization: McpAuthorizationContext | undefined,
  variant: string | undefined,
  options: McpEventCursorOptions & { ttlMs: number }
): string | null {
  if (cursor === null) return null
  const envelope: EventCursorEnvelope = {
    v: 1,
    name,
    argumentsHash: sha256(canonicalJson(arguments_)),
    principal: eventPrincipalKey(authorization),
    variant,
    exp: Date.now() + options.ttlMs,
    cursor
  }
  const payload = Buffer.from(JSON.stringify(envelope)).toString('base64url')
  const signature = createHmac('sha256', options.signingKey).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function decodeEventCursor(
  value: unknown,
  name: string,
  arguments_: Record<string, unknown>,
  authorization: McpAuthorizationContext | undefined,
  variant: string | undefined,
  options: McpEventCursorOptions & { ttlMs: number }
): { cursor: string | null; expired: boolean } {
  if (value === undefined || value === null) return { cursor: null, expired: false }
  if (typeof value !== 'string') throw new TypeError('Invalid event cursor')
  const [payload, supplied, ...rest] = value.split('.')
  if (!payload || !supplied || rest.length > 0) throw new TypeError('Invalid event cursor')
  const expected = createHmac('sha256', options.signingKey).update(payload).digest()
  let signature: Uint8Array
  try {
    signature = Buffer.from(supplied, 'base64url')
  } catch {
    throw new TypeError('Invalid event cursor')
  }
  if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected))
    throw new TypeError('Invalid event cursor')
  let envelope: EventCursorEnvelope
  try {
    envelope = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new TypeError('Invalid event cursor')
  }
  if (
    envelope.v !== 1 ||
    envelope.name !== name ||
    envelope.argumentsHash !== sha256(canonicalJson(arguments_)) ||
    envelope.principal !== eventPrincipalKey(authorization) ||
    envelope.variant !== variant ||
    !Number.isSafeInteger(envelope.exp) ||
    typeof envelope.cursor !== 'string'
  )
    throw new TypeError('Invalid event cursor')
  return { cursor: envelope.cursor, expired: envelope.exp <= Date.now() }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON requires finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  throw new TypeError('Value is not canonical JSON')
}

export function eventPrincipalKey(
  authorization: McpAuthorizationContext | undefined
): string | undefined {
  const principal = authorization?.principal
  return principal
    ? canonicalJson([
        principal.issuer ?? null,
        principal.subject ?? null,
        principal.clientId ?? null
      ])
    : undefined
}

export function eventVariantKey(meta: Record<string, unknown> | undefined): string | undefined {
  const value = meta?.['io.modelcontextprotocol/server-variant']
  return typeof value === 'string' ? value : undefined
}

function sha256(value: string): string {
  return createHmac('sha256', 'mcp-events-binding').update(value).digest('hex')
}
