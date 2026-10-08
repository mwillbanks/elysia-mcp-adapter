import type { JsonSchema, McpInvocationContext } from '../../types.js'

export const MCP_INTERCEPTORS_ID = 'io.modelcontextprotocol/interceptors' as const
export const MCP_INTERCEPTORS_REVISION = 'b60459844cc95f2170297ebe1c84b7de8b752953' as const

export type McpInterceptorPhase = 'request' | 'response'
export type McpInterceptorMode = 'active' | 'audit'
export type McpInterceptorType = 'validation' | 'mutation'
export type McpInterceptorPriority = number | { request?: number; response?: number }
export type McpInterceptorDirection = 'sending' | 'receiving'

export interface McpInterceptorResultBase {
  interceptor: string
  type: McpInterceptorType
  phase: McpInterceptorPhase
  durationMs?: number
  info?: Record<string, unknown>
}

export interface McpInterceptorHook {
  events: string[]
  phase: McpInterceptorPhase
}
export interface McpInterceptorDefinition {
  name: string
  version: string
  description: string
  type: McpInterceptorType
  hooks: McpInterceptorHook[]
  mode?: McpInterceptorMode
  failOpen?: boolean
  priorityHint?: McpInterceptorPriority
  compat?: { minProtocol?: string; maxProtocol?: string }
  configSchema?: JsonSchema
  payloadSchema?: JsonSchema
}

export interface McpInterceptorInvocation {
  name: string
  event: string
  phase: McpInterceptorPhase
  payload: unknown
  config?: Record<string, unknown>
  timeoutMs?: number
}

export interface McpValidationResult extends McpInterceptorResultBase {
  type: 'validation'
  valid: boolean
  severity?: 'info' | 'warn' | 'error'
  messages?: Array<{ path?: string; message: string; severity: 'info' | 'warn' | 'error' }>
  suggestions?: Array<{ path: string; value: unknown }>
  signature?: { algorithm: 'ed25519'; publicKey: string; value: string }
}

export interface McpMutationResult extends McpInterceptorResultBase {
  type: 'mutation'
  modified: boolean
  payload: unknown
}
export type McpInterceptorResult = McpValidationResult | McpMutationResult
export type McpInterceptorHandlerResult =
  | (Omit<McpValidationResult, 'interceptor' | 'type' | 'phase'> & {
      interceptor?: string
      type?: 'validation'
      phase?: McpInterceptorPhase
    })
  | (Omit<McpMutationResult, 'interceptor' | 'type' | 'phase'> & {
      interceptor?: string
      type?: 'mutation'
      phase?: McpInterceptorPhase
    })
export type McpInterceptorHandler = (
  invocation: McpInterceptorInvocation,
  context: McpInvocationContext & { signal: AbortSignal }
) => McpInterceptorHandlerResult | Promise<McpInterceptorHandlerResult>

export interface McpInterceptorRegistration {
  definition: McpInterceptorDefinition
  handler: McpInterceptorHandler
}

export interface McpInterceptorsOptions {
  version?: 'current' | typeof MCP_INTERCEPTORS_REVISION
}

export interface McpInterceptorChainEntry {
  registration: McpInterceptorRegistration
  overrides?: {
    hooks?: McpInterceptorHook[]
    mode?: McpInterceptorMode
    failOpen?: boolean
    priorityHint?: McpInterceptorPriority
    timeoutMs?: number
    config?: Record<string, unknown>
  }
}

export interface McpInterceptorAuditOutcome {
  interceptor: string
  status: 'completed' | 'failed'
  severity: 'warn' | 'error'
  result?: McpInterceptorResult
  error?: unknown
}
