import type { McpInterceptorInvocationContext } from './types.js'

export function validInterceptorConfig(value: unknown): boolean {
  return value === undefined || (isRecord(value) && isJsonValue(value))
}

export function validInterceptorContext(
  value: unknown
): value is McpInterceptorInvocationContext | undefined {
  if (value === undefined) return true
  if (!isRecord(value) || !isJsonValue(value)) return false
  return (
    validTimestamp(value.timestamp) &&
    ['traceId', 'spanId', 'sessionId'].every((field) => optionalString(value[field])) &&
    (value.interceptorState === undefined || isRecord(value.interceptorState)) &&
    validPrincipal(value.principal)
  )
}

function validTimestamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    validCalendarDate(value.slice(0, 10))
  )
}

function validCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function validPrincipal(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || typeof value.type !== 'string') return false
  return (
    ['user', 'service', 'anonymous'].includes(value.type) &&
    optionalString(value.id) &&
    (value.claims === undefined || isRecord(value.claims))
  )
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!Array.isArray(value) && !isRecord(value)) return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Object.values(value).every((entry) => isJsonValue(entry, seen))
  seen.delete(value)
  return valid
}
