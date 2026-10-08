import type { McpAuthorizationContext } from '../extensions/auth/index.js'
import { isRecord } from '../internal.js'
import type { McpInvocationContext } from '../types.js'
import type { McpRequestProtocolContext } from './protocol.js'

export interface InvocationContextSource {
  protocol: McpRequestProtocolContext
  authorization?: McpAuthorizationContext
  signal?: AbortSignal
  reportProgress?: McpInvocationContext['reportProgress']
}

export function invocationContextBase(
  request: Request,
  params: Record<string, unknown>,
  context: InvocationContextSource
): McpInvocationContext {
  return {
    request,
    signal: context.signal ?? request.signal,
    meta: isRecord(params._meta) ? params._meta : undefined,
    protocolVersion: context.protocol.version,
    clientCapabilities: context.protocol.clientCapabilities,
    clientInfo: context.protocol.clientInfo,
    authorization: context.authorization,
    reportProgress: context.reportProgress
  }
}
