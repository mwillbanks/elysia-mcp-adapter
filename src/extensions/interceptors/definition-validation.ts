import type { McpInterceptorDefinition } from './types.js'

export function assertInterceptorDefinition(value: McpInterceptorDefinition): void {
  if (!validIdentity(value)) throw new TypeError('Interceptor identity is invalid')
  if (value.type !== 'validation' && value.type !== 'mutation') {
    throw new TypeError('Interceptor type is invalid')
  }
  if (!validHooks(value.hooks)) throw new TypeError('Interceptor hooks are invalid')
  if (value.mode !== undefined && value.mode !== 'active' && value.mode !== 'audit') {
    throw new TypeError('Interceptor mode is invalid')
  }
  if (value.failOpen !== undefined && typeof value.failOpen !== 'boolean') {
    throw new TypeError('Interceptor failOpen is invalid')
  }
  if (!validPriority(value.priorityHint)) throw new TypeError('Interceptor priorityHint is invalid')
  if (!validCompatibility(value.compat)) throw new TypeError('Interceptor compat is invalid')
  assertSchemaShape('configSchema', value.configSchema)
  assertSchemaShape('payloadSchema', value.payloadSchema)
}

function validIdentity(value: McpInterceptorDefinition): boolean {
  return (
    Boolean(value) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.version === 'string' &&
    value.version.length > 0 &&
    typeof value.description === 'string'
  )
}

function validHooks(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(validHook)
}

function validHook(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const hook = value as { phase?: unknown; events?: unknown }
  if (hook.phase !== 'request' && hook.phase !== 'response') return false
  return Array.isArray(hook.events) && hook.events.length > 0 && hook.events.every(validEvent)
}

function validEvent(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

function validCompatibility(value: McpInterceptorDefinition['compat']): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  if (value.minProtocol !== undefined && typeof value.minProtocol !== 'string') return false
  return value.maxProtocol === undefined || typeof value.maxProtocol === 'string'
}

function assertSchemaShape(label: string, value: unknown): void {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Interceptor ${label} is invalid`)
  }
}

function validPriority(value: McpInterceptorDefinition['priorityHint']): boolean {
  if (value === undefined) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!Object.keys(value).every((key) => key === 'request' || key === 'response')) return false
  return [value.request, value.response].every(optionalFiniteNumber)
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}
