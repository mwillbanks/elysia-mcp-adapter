import type { McpInterceptorDefinition, McpInterceptorResult } from './types.js'

const SEVERITIES = new Set(['info', 'warn', 'error'])

export function normalizeInterceptorResult(
  definition: McpInterceptorDefinition,
  phase: 'request' | 'response',
  result: unknown
): McpInterceptorResult {
  if (!result || typeof result !== 'object') throw new TypeError('Interceptor result is invalid')
  const candidate = result as Record<string, unknown>
  assertResultEnvelope(candidate, definition, phase)
  assertResultMetadata(candidate)
  if (definition.type === 'validation') assertValidationResult(candidate)
  else assertMutationResult(candidate)
  return structuredClone({
    ...candidate,
    interceptor: definition.name,
    type: definition.type,
    phase
  }) as McpInterceptorResult
}

function assertResultEnvelope(
  candidate: Record<string, unknown>,
  definition: McpInterceptorDefinition,
  phase: 'request' | 'response'
): void {
  if (candidate.interceptor !== undefined && candidate.interceptor !== definition.name) {
    throw new TypeError('Interceptor result identity is inconsistent')
  }
  if (candidate.type !== undefined && candidate.type !== definition.type) {
    throw new TypeError('Interceptor result type is inconsistent')
  }
  if (candidate.phase !== undefined && candidate.phase !== phase) {
    throw new TypeError('Interceptor result phase is inconsistent')
  }
}

function assertResultMetadata(candidate: Record<string, unknown>): void {
  if (candidate.durationMs !== undefined && !validDuration(candidate.durationMs)) {
    throw new TypeError('Interceptor result durationMs is invalid')
  }
  if (candidate.info !== undefined && !isPlainObject(candidate.info)) {
    throw new TypeError('Interceptor result info is invalid')
  }
}

function validDuration(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isPlainObject(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertValidationResult(candidate: Record<string, unknown>): void {
  if (typeof candidate.valid !== 'boolean') throw new TypeError('Validator result is invalid')
  assertOptionalResultField(candidate, 'severity', validSeverity, 'Validator severity is invalid')
  assertOptionalResultField(candidate, 'messages', validMessages, 'Validator messages are invalid')
  assertOptionalResultField(
    candidate,
    'suggestions',
    validSuggestions,
    'Validator suggestions are invalid'
  )
  assertOptionalResultField(
    candidate,
    'signature',
    validSignature,
    'Validator signature is invalid'
  )
}

function assertOptionalResultField(
  candidate: Record<string, unknown>,
  field: string,
  validate: (value: unknown) => boolean,
  message: string
): void {
  if (candidate[field] !== undefined && !validate(candidate[field])) throw new TypeError(message)
}

function validSeverity(value: unknown): boolean {
  return typeof value === 'string' && SEVERITIES.has(value)
}

function validMessages(value: unknown): boolean {
  return Array.isArray(value) && value.every(validMessage)
}

function validMessage(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const message = value as Record<string, unknown>
  if (typeof message.message !== 'string' || !validSeverity(message.severity)) return false
  return message.path === undefined || typeof message.path === 'string'
}

function validSuggestions(value: unknown): boolean {
  return Array.isArray(value) && value.every(validSuggestion)
}

function validSuggestion(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const suggestion = value as Record<string, unknown>
  return typeof suggestion.path === 'string' && 'value' in suggestion
}

function validSignature(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const signature = value as Record<string, unknown>
  if (signature.algorithm !== 'ed25519') return false
  return typeof signature.publicKey === 'string' && typeof signature.value === 'string'
}

function assertMutationResult(candidate: Record<string, unknown>): void {
  if (typeof candidate.modified !== 'boolean' || !('payload' in candidate)) {
    throw new TypeError('Mutator result is invalid')
  }
}
