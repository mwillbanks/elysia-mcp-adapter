import { createHmac, timingSafeEqual } from 'node:crypto'
import { isRecord } from '../internal.js'
import { McpProtocolError } from './protocol-error.js'

export interface SignedEnvelope {
  v: 1
  kind: 'continuation' | 'cursor'
  id: string
  exp: number
  method: string
  binding: string
  principal?: string
  variant?: string
  value: string
}

export function signEnvelope(envelope: SignedEnvelope, key: string | Uint8Array): string {
  const body = Buffer.from(JSON.stringify(envelope)).toString('base64url')
  const signature = createHmac('sha256', key).update(body).digest('base64url')
  return `${body}.${signature}`
}

export function verifyEnvelope(
  token: string,
  key: string | Uint8Array,
  kind: SignedEnvelope['kind'],
  method: string,
  params: Record<string, unknown>,
  principal: string | undefined,
  ignoreCursor = false
): SignedEnvelope {
  const envelope = authenticateEnvelope(token, key, kind)
  if (envelope.exp <= Date.now()) throw new McpProtocolError(-32602, `${kind} expired`, 400)
  if (!matchesRequest(envelope, method, params, principal, ignoreCursor)) {
    throw new McpProtocolError(-32602, `${kind} does not match this request`, 400)
  }
  return envelope
}

export function requestBinding(
  method: string,
  params: Record<string, unknown>,
  ignoreCursor = false
): string {
  const salient = Object.fromEntries(
    Object.entries(params).filter(([key]) => includedBindingKey(key, ignoreCursor))
  )
  return createHmac('sha256', 'mcp-request-binding')
    .update(stableJson([method, salient]))
    .digest('base64url')
}

export function variantKey(params: Record<string, unknown>): string | undefined {
  const meta = isRecord(params._meta) ? params._meta : undefined
  const value = meta?.['io.modelcontextprotocol/server-variant']
  return typeof value === 'string' ? value : undefined
}

function authenticateEnvelope(
  token: string,
  key: string | Uint8Array,
  kind: SignedEnvelope['kind']
): SignedEnvelope {
  const [body, suppliedSignature, ...rest] = token.split('.')
  if (!body || !suppliedSignature || rest.length > 0) return invalidEnvelope(kind)
  if (!validSignature(body, suppliedSignature, key)) return invalidEnvelope(kind)
  const value = decodeEnvelope(body, kind)
  if (!isSignedEnvelope(value, kind)) return invalidEnvelope(kind)
  return value
}

function validSignature(
  body: string,
  suppliedSignature: string,
  key: string | Uint8Array
): boolean {
  const expected = createHmac('sha256', key).update(body).digest()
  let supplied: Buffer
  try {
    supplied = Buffer.from(suppliedSignature, 'base64url')
  } catch {
    return false
  }
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
}

function decodeEnvelope(body: string, kind: SignedEnvelope['kind']): unknown {
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return invalidEnvelope(kind)
  }
}

function isSignedEnvelope(value: unknown, kind: SignedEnvelope['kind']): value is SignedEnvelope {
  if (!isRecord(value) || value.v !== 1 || value.kind !== kind) return false
  if (!validRequiredEnvelopeFields(value)) return false
  return optionalString(value.principal) && optionalString(value.variant)
}

function validRequiredEnvelopeFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    typeof value.exp === 'number' &&
    typeof value.method === 'string' &&
    typeof value.binding === 'string' &&
    typeof value.value === 'string'
  )
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function matchesRequest(
  envelope: SignedEnvelope,
  method: string,
  params: Record<string, unknown>,
  principal: string | undefined,
  ignoreCursor: boolean
): boolean {
  if (envelope.method !== method || envelope.principal !== principal) return false
  if (envelope.variant !== variantKey(params)) return false
  return envelope.binding === requestBinding(method, params, ignoreCursor)
}

function includedBindingKey(key: string, ignoreCursor: boolean): boolean {
  if (key === '_meta' || key === 'inputResponses' || key === 'requestState') return false
  return !ignoreCursor || key !== 'cursor'
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null'
  const properties = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
  return `{${properties.join(',')}}`
}

function invalidEnvelope(kind: SignedEnvelope['kind']): never {
  throw new McpProtocolError(-32602, `Invalid ${kind}`, 400)
}
