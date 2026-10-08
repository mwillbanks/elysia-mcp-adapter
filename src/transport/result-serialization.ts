import { assertTrustResultMetadata } from '../extensions/annotations/index.js'
import { isRecord } from '../internal.js'
import type {
  McpInputRequiredResult,
  McpInvocationContext,
  NormalizedMcpPluginOptions
} from '../types.js'
import {
  cachePolicy,
  isInputRequiredResult,
  modernResultMeta,
  prepareInputRequiredResult
} from './core.js'
import type { McpRequestProtocolContext } from './protocol.js'

export interface ResultSerializationRuntime {
  error: (code: number, message: string) => Error
}

const CACHEABLE_METHODS = new Set([
  'server/discover',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list'
])

function assertLegacyResult(
  result: Record<string, unknown>,
  runtime: ResultSerializationRuntime
): Record<string, unknown> {
  if (isInputRequiredResult(result)) {
    throw runtime.error(-32603, 'Input-required results require MCP 2026-07-28')
  }
  return result
}

function modernMetadata(
  result: Record<string, unknown>,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  return {
    ...result,
    resultType: result.resultType === 'task' ? 'task' : 'complete',
    _meta: {
      ...modernResultMeta(options),
      ...(isRecord(result._meta) ? result._meta : {})
    }
  }
}

function inputRequiredMetadata(
  result: McpInputRequiredResult,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  return {
    ...result,
    _meta: { ...modernResultMeta(options), ...(result._meta ?? {}) }
  }
}

async function addCachePolicy(
  method: string,
  result: Record<string, unknown>,
  params: Record<string, unknown>,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<Record<string, unknown>> {
  if (!CACHEABLE_METHODS.has(method)) return result
  if (params.inputResponses !== undefined || params.requestState !== undefined) return result
  return { ...result, ...(await cachePolicy(method, context, options)) }
}

export async function serializeProtocolResult(
  method: string,
  result: unknown,
  protocol: McpRequestProtocolContext,
  params: Record<string, unknown>,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions,
  runtime: ResultSerializationRuntime
): Promise<unknown> {
  if (!isRecord(result)) return result
  if (method === 'tools/call') assertTrustResultMetadata(result._meta)
  if (!protocol.modern) return assertLegacyResult(result, runtime)
  const prepared = prepareInputRequiredResult(result, method, params, context, options)
  if (isInputRequiredResult(prepared)) return inputRequiredMetadata(prepared, options)
  return addCachePolicy(method, modernMetadata(result, options), params, context, options)
}
