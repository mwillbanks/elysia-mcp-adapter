import type { McpAuthorizationContext } from '../extensions/auth/index.js'
import type { TaskRequestContext } from '../extensions/tasks/types.js'
import { isRecord } from '../internal.js'
import type { McpHandlerContext, McpInvocationContext } from '../types.js'
import { createInvocationInput } from './input.js'
import { type McpInvocationNotify, silentNotify } from './notifications.js'
import type { McpRequestProtocolContext } from './protocol.js'

export interface InvocationContextSource {
  protocol: McpRequestProtocolContext
  authorization?: McpAuthorizationContext
  signal?: AbortSignal
  notify?: McpInvocationNotify
  reportProgress?: McpInvocationContext['reportProgress']
  inputResponses?: McpInvocationContext['inputResponses']
  requestState?: string
  signedState?: boolean
}

export function taskRequestContext(
  request: Request,
  params: Record<string, unknown>,
  context: Pick<InvocationContextSource, 'authorization' | 'signal'>
): TaskRequestContext {
  const principal = context.authorization?.principal
  return {
    request,
    signal: context.signal ?? request.signal,
    meta: isRecord(params._meta) ? params._meta : undefined,
    principalKey: principal
      ? JSON.stringify([
          principal.issuer ?? null,
          principal.subject ?? null,
          principal.clientId ?? null
        ])
      : undefined
  }
}

export function invocationContextBase(
  request: Request,
  params: Record<string, unknown>,
  context: InvocationContextSource
): McpHandlerContext {
  return {
    request,
    signal: context.signal ?? request.signal,
    meta: isRecord(params._meta) ? params._meta : undefined,
    protocolVersion: context.protocol.version,
    ...(context.protocol.language && {
      contentLanguage: context.protocol.language.contentLanguage
    }),
    clientCapabilities: context.protocol.clientCapabilities,
    clientInfo: context.protocol.clientInfo,
    authorization: context.authorization,
    notify: context.notify ?? silentNotify,
    input: createInvocationInput({
      modern: context.protocol.modern,
      capabilities: context.protocol.clientCapabilities,
      responses: context.inputResponses,
      signedState: context.signedState
    }),
    inputResponses: context.inputResponses,
    requestState: context.requestState,
    reportProgress: context.reportProgress
  }
}
