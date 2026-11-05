import { isRecord } from '../internal.js'
import { isMcpElicitationResult, isMcpRootsResult, isMcpSamplingResult } from '../schema/content.js'
import { validateTransientJsonSchema } from '../schema/validate.js'
import type {
  McpElicitationFormRequest,
  McpElicitationResult,
  McpElicitationUrlRequest,
  McpInputRequest,
  McpInputRequiredResult,
  McpInputResponses,
  McpRootsRequest,
  McpRootsResult,
  McpSamplingRequest,
  McpSamplingResult
} from '../types.js'
import { assertInputRequestCapabilities } from './input-request-validation.js'
import { McpProtocolError } from './protocol-error.js'

export const mcpInput = {
  form: (params: McpElicitationFormRequest['params']): McpElicitationFormRequest => ({
    method: 'elicitation/create',
    params: { ...params, mode: 'form' }
  }),
  url: (params: Omit<McpElicitationUrlRequest['params'], 'mode'>): McpElicitationUrlRequest => ({
    method: 'elicitation/create',
    params: { ...params, mode: 'url' }
  }),
  sampling: (params: McpSamplingRequest['params']): McpSamplingRequest => ({
    method: 'sampling/createMessage',
    params
  }),
  roots: (): McpRootsRequest => ({ method: 'roots/list' })
}

type ElicitationAnswer =
  { action: 'accept'; content?: McpElicitationResult['content'] } | { action: 'decline' | 'cancel' }

export type McpInputAnswer<Request extends McpInputRequest> = Request extends McpRootsRequest
  ? McpRootsResult
  : Request extends McpSamplingRequest
    ? McpSamplingResult
    : ElicitationAnswer

export interface McpInvocationInput {
  supports(request: McpInputRequest): boolean
  require(
    requests: Record<string, McpInputRequest>,
    options?: { state?: string }
  ): McpInputRequiredResult
  response<Request extends McpInputRequest>(
    key: string,
    request: Request
  ): McpInputAnswer<Request> | undefined
}

export function createInvocationInput({
  modern,
  capabilities,
  responses,
  signedState = false
}: {
  modern: boolean
  capabilities?: Record<string, unknown>
  responses?: McpInputResponses
  signedState?: boolean
}): McpInvocationInput {
  return {
    supports(request) {
      if (!modern) return false
      try {
        assertInputRequestCapabilities({ request }, capabilities)
        return true
      } catch (error) {
        if (error instanceof McpProtocolError && error.code === -32021) return false
        throw error
      }
    },
    require(requests, { state } = {}) {
      if (!modern) {
        throw new McpProtocolError(-32603, 'Input-required results require MCP 2026-07-28')
      }
      const hasRequests = assertInputRequiredOptions(requests, state, signedState)
      assertInputRequestCapabilities(requests, capabilities)
      return {
        resultType: 'input_required',
        ...(hasRequests ? { inputRequests: requests } : {}),
        ...(state === undefined ? {} : { requestState: state })
      }
    },
    response<Request extends McpInputRequest>(key: string, request: Request) {
      if (!responses || !Object.hasOwn(responses, key)) return undefined
      return validateInputAnswer(key, request, responses[key]) as McpInputAnswer<Request>
    }
  }
}

function assertInputRequiredOptions(requests: unknown, state: unknown, signedState: boolean) {
  if (state !== undefined && (!signedState || typeof state !== 'string')) {
    throw new McpProtocolError(
      -32603,
      'Input helper state requires configured continuation signing'
    )
  }
  if (!isRecord(requests)) {
    throw new McpProtocolError(-32603, 'Input requests must be an object')
  }
  const hasRequests = Object.keys(requests).length > 0
  if (!hasRequests && state === undefined) {
    throw new McpProtocolError(-32603, 'Input-required results require requests or state')
  }
  return hasRequests
}

export function validateInputAnswer(key: string, request: McpInputRequest, response: unknown) {
  if (request.method === 'roots/list' && isMcpRootsResult(response)) return response
  if (request.method === 'sampling/createMessage' && isMcpSamplingResult(response)) return response
  if (request.method === 'elicitation/create' && isMcpElicitationResult(response)) {
    if (response.action !== 'accept') return { action: response.action }
    if (request.params.mode === 'url' && response.content === undefined) return { action: 'accept' }
    if (
      request.params.mode !== 'url' &&
      validateTransientJsonSchema(request.params.requestedSchema, response.content).ok
    ) {
      return { action: 'accept', content: response.content }
    }
  }
  throw new McpProtocolError(-32602, `Invalid response for input request: ${key}`, 400)
}
