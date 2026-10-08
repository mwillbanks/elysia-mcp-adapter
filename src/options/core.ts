import type { McpPluginOptions, NormalizedMcpPluginOptions } from '../types.js'
import {
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertSigningKey,
  withDefault
} from './validation.js'

type CoreOptions = NonNullable<McpPluginOptions['core']>

function validateContinuation(continuation: CoreOptions['continuation']): void {
  if (!continuation) return
  assertSigningKey(continuation.signingKey, 'Continuation')
  assertPositiveInteger(continuation.ttlMs, 'Continuation ttlMs')
  if (continuation.singleUse && !continuation.provider) {
    throw new TypeError('Single-use continuation protection requires an application provider')
  }
}

function validatePagination(pagination: CoreOptions['pagination']): void {
  if (!pagination) return
  assertSigningKey(pagination.signingKey, 'Pagination')
  assertPositiveInteger(pagination.pageSize, 'Pagination pageSize')
  assertPositiveInteger(pagination.cursorTtlMs, 'Pagination cursorTtlMs')
}

function validateSubscriptions(subscriptions: CoreOptions['subscriptions']): void {
  assertPositiveInteger(subscriptions?.heartbeatMs, 'Subscription heartbeatMs')
}

export function normalizeCore(options: McpPluginOptions): NormalizedMcpPluginOptions['core'] {
  const core = options.core
  const maxToolInputElements = core?.maxToolInputElements
  validateInputLimit(maxToolInputElements)
  validateContinuation(core?.continuation)
  validatePagination(core?.pagination)
  validateSubscriptions(core?.subscriptions)

  const cacheDefault = core?.cache?.default
  const ttlMs = withDefault(cacheDefault?.ttlMs, 0)
  assertNonNegativeInteger(ttlMs, 'Cache ttlMs')
  return {
    maxToolInputElements,
    continuation: core?.continuation
      ? {
          ...core.continuation,
          ttlMs: withDefault(core.continuation.ttlMs, 5 * 60_000),
          singleUse: withDefault(core.continuation.singleUse, false)
        }
      : undefined,
    pagination: core?.pagination
      ? { ...core.pagination, cursorTtlMs: withDefault(core.pagination.cursorTtlMs, 5 * 60_000) }
      : undefined,
    cache: {
      default: { cacheScope: withDefault(cacheDefault?.cacheScope, 'private'), ttlMs },
      policy: core?.cache?.policy
    },
    subscriptions: core?.subscriptions
      ? { ...core.subscriptions, heartbeatMs: withDefault(core.subscriptions.heartbeatMs, 15_000) }
      : undefined
  }
}

function validateInputLimit(value: number | undefined): void {
  if (value === undefined) return
  if (Number.isSafeInteger(value) && value > 0) return
  throw new TypeError('Core maxToolInputElements must be a positive safe integer')
}
