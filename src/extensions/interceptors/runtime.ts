import { validateJsonSchema } from '../../schema/validate.js'
import type { McpInvocationContext } from '../../types.js'
import type {
  McpInterceptorAuditOutcome,
  McpInterceptorChainEntry,
  McpInterceptorDefinition,
  McpInterceptorDirection,
  McpInterceptorInvocation,
  McpInterceptorRegistration,
  McpInterceptorResult,
  McpMutationResult,
  McpValidationResult
} from './types.js'

export function assertInterceptorDefinition(value: McpInterceptorDefinition): void {
  if (
    !value ||
    typeof value.name !== 'string' ||
    !value.name ||
    typeof value.version !== 'string' ||
    !value.version ||
    typeof value.description !== 'string'
  )
    throw new TypeError('Interceptor identity is invalid')
  if (!['validation', 'mutation'].includes(value.type))
    throw new TypeError('Interceptor type is invalid')
  if (
    !Array.isArray(value.hooks) ||
    value.hooks.length === 0 ||
    value.hooks.some(
      (hook) =>
        !['request', 'response'].includes(hook.phase) ||
        !Array.isArray(hook.events) ||
        hook.events.length === 0 ||
        hook.events.some((event) => typeof event !== 'string' || !event)
    )
  )
    throw new TypeError('Interceptor hooks are invalid')
  if (value.mode !== undefined && !['active', 'audit'].includes(value.mode))
    throw new TypeError('Interceptor mode is invalid')
  if (value.failOpen !== undefined && typeof value.failOpen !== 'boolean')
    throw new TypeError('Interceptor failOpen is invalid')
  if (!validPriority(value.priorityHint)) throw new TypeError('Interceptor priorityHint is invalid')
  if (
    value.compat !== undefined &&
    (!value.compat ||
      typeof value.compat !== 'object' ||
      (value.compat.minProtocol !== undefined && typeof value.compat.minProtocol !== 'string') ||
      (value.compat.maxProtocol !== undefined && typeof value.compat.maxProtocol !== 'string'))
  )
    throw new TypeError('Interceptor compat is invalid')
  for (const [label, schema] of [
    ['configSchema', value.configSchema],
    ['payloadSchema', value.payloadSchema]
  ] as const) {
    if (schema !== undefined && (!schema || typeof schema !== 'object' || Array.isArray(schema)))
      throw new TypeError(`Interceptor ${label} is invalid`)
  }
}

export function interceptorMatches(
  definition: McpInterceptorDefinition,
  event: string,
  phase: 'request' | 'response'
): boolean {
  return definition.hooks.some(
    (hook) =>
      hook.phase === phase &&
      hook.events.some((candidate) => candidate === '*' || candidate === event)
  )
}

export async function invokeInterceptor(
  registration: McpInterceptorRegistration,
  invocation: McpInterceptorInvocation,
  context: McpInvocationContext
): Promise<McpInterceptorResult> {
  assertInterceptorDefinition(registration.definition)
  if (invocation.event.length === 0) throw new TypeError('Interceptor event is required')
  if (!interceptorMatches(registration.definition, invocation.event, invocation.phase))
    throw new TypeError('Interceptor does not declare this event and phase')
  if (
    invocation.timeoutMs !== undefined &&
    (!Number.isSafeInteger(invocation.timeoutMs) || invocation.timeoutMs <= 0)
  )
    throw new TypeError('Interceptor timeoutMs must be positive')
  if (registration.definition.configSchema) {
    try {
      assertSchema(registration.definition.configSchema, invocation.config ?? {}, 'configuration')
    } catch (cause) {
      throw new McpInterceptorExecutionError(
        registration.definition.name,
        'Configuration invalid',
        { cause }
      )
    }
  }
  if (registration.definition.payloadSchema) {
    try {
      assertSchema(registration.definition.payloadSchema, invocation.payload, 'payload')
    } catch (cause) {
      throw new McpInterceptorExecutionError(registration.definition.name, 'Payload invalid', {
        cause
      })
    }
  }
  const controller = new AbortController()
  const relay = () => controller.abort(context.signal?.reason)
  if (context.signal?.aborted) {
    controller.abort(context.signal.reason)
    throw new DOMException('Interceptor invocation was aborted', 'AbortError')
  }
  context.signal?.addEventListener('abort', relay, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const execution = Promise.resolve()
      .then(() =>
        registration.handler(
          { ...invocation, payload: structuredClone(invocation.payload) },
          { ...context, signal: controller.signal }
        )
      )
      .catch((cause) => {
        throw new McpInterceptorExecutionError(registration.definition.name, 'Handler failed', {
          cause
        })
      })
    const result =
      invocation.timeoutMs === undefined
        ? await execution
        : await Promise.race([
            execution,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort('Interceptor execution timeout')
                reject(
                  new McpInterceptorTimeoutError(
                    registration.definition.name,
                    invocation.timeoutMs as number,
                    invocation.phase
                  )
                )
              }, invocation.timeoutMs)
            })
          ])
    try {
      return normalizeInterceptorResult(registration.definition, invocation.phase, result)
    } catch (cause) {
      throw new McpInterceptorExecutionError(registration.definition.name, 'Result invalid', {
        cause
      })
    }
  } finally {
    if (timer) clearTimeout(timer)
    context.signal?.removeEventListener('abort', relay)
  }
}

export class McpInterceptorExecutionError extends Error {
  readonly code = -32603
  constructor(
    readonly interceptor: string,
    readonly reason: string,
    options?: ErrorOptions
  ) {
    super('Interceptor execution failed', options)
  }
}

export class McpInterceptorTimeoutError extends Error {
  readonly code = -32000
  constructor(
    readonly interceptor: string,
    readonly timeoutMs: number,
    readonly phase: string
  ) {
    super('Interceptor execution timeout')
  }
}

export class McpInterceptorMutationError extends Error {
  readonly code = -32603
  readonly data: { failedInterceptor: string; lastValidPayload: unknown }
  constructor(failedInterceptor: string, originalPayload: unknown, options?: ErrorOptions) {
    super('Interceptor mutation failed', options)
    this.data = {
      failedInterceptor,
      lastValidPayload: structuredClone(originalPayload)
    }
  }
}

export interface McpInterceptorValidationFailure {
  interceptor: string
  severity: 'error'
  message: string
}

export class McpInterceptorValidationError extends Error {
  readonly code = -32602
  readonly data: { validationErrors: McpInterceptorValidationFailure[] }
  constructor(validationErrors: McpInterceptorValidationFailure[]) {
    super('Interceptor validation failed')
    this.data = { validationErrors: structuredClone(validationErrors) }
  }
}

export async function executeInterceptorChain(
  entries: readonly McpInterceptorChainEntry[],
  event: string,
  phase: 'request' | 'response',
  payload: unknown,
  context: McpInvocationContext,
  direction: McpInterceptorDirection = phase === 'request' ? 'receiving' : 'sending'
): Promise<{
  payload: unknown
  validations: McpValidationResult[]
  audit: McpInterceptorAuditOutcome[]
}> {
  if (event.length === 0) throw new TypeError('Interceptor event is required')
  const applicable = entries
    .map((entry, ordinal) => ({ entry, ordinal }))
    .filter(({ entry }) => {
      assertNarrowedHooks(entry)
      const definition = {
        ...entry.registration.definition,
        hooks: entry.overrides?.hooks ?? entry.registration.definition.hooks
      }
      return interceptorMatches(definition, event, phase)
    })
  const mutations = applicable
    .filter(({ entry }) => entry.registration.definition.type === 'mutation')
    .sort(
      (a, b) =>
        priority(a.entry, phase) - priority(b.entry, phase) ||
        a.entry.registration.definition.name.localeCompare(b.entry.registration.definition.name) ||
        a.ordinal - b.ordinal
    )
  const audit: McpInterceptorAuditOutcome[] = []
  const originalPayload = structuredClone(payload)
  let current = structuredClone(originalPayload)
  const validators = applicable.filter(
    ({ entry }) => entry.registration.definition.type === 'validation'
  )
  const runMutations = async () => {
    for (const { entry } of mutations) {
      try {
        const result = (await invokeInterceptor(
          entry.registration,
          invocationFor(entry, event, phase, current),
          context
        )) as McpMutationResult
        if ((entry.overrides?.mode ?? entry.registration.definition.mode) === 'audit')
          audit.push({
            interceptor: entry.registration.definition.name,
            status: 'completed',
            severity: 'warn',
            result
          })
        else if (result.modified) current = structuredClone(result.payload)
      } catch (error) {
        if (nonBlocking(entry)) {
          audit.push(failedAudit(entry, error))
          continue
        }
        throw new McpInterceptorMutationError(entry.registration.definition.name, originalPayload, {
          cause: error
        })
      }
    }
  }
  const runValidations = async () => {
    const outcomes = await Promise.all(
      validators.map(async ({ entry }) => {
        try {
          const result = (await invokeInterceptor(
            entry.registration,
            invocationFor(entry, event, phase, current),
            context
          )) as McpValidationResult
          if ((entry.overrides?.mode ?? entry.registration.definition.mode) === 'audit')
            audit.push({
              interceptor: entry.registration.definition.name,
              status: 'completed',
              severity: result.severity === 'error' ? 'error' : 'warn',
              result
            })
          return { ok: true as const, result }
        } catch (error) {
          if (nonBlocking(entry)) {
            audit.push(failedAudit(entry, error))
            return { ok: true as const, result: syntheticValidation(entry, phase) }
          }
          return { ok: false as const, error }
        }
      })
    )
    const failedExecution = outcomes.find((outcome) => !outcome.ok)
    if (failedExecution) throw failedExecution.error
    const results = outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.result)
    const validationErrors = validators.flatMap(({ entry }, index) => {
      const result = results[index]
      if (
        (entry.overrides?.mode ?? entry.registration.definition.mode) === 'audit' ||
        result?.valid !== false ||
        result.severity !== 'error'
      )
        return []
      const messages = result.messages?.filter(({ severity }) => severity === 'error') ?? []
      return messages.length > 0
        ? messages.map(({ message }) => ({
            interceptor: entry.registration.definition.name,
            severity: 'error' as const,
            message
          }))
        : [
            {
              interceptor: entry.registration.definition.name,
              severity: 'error' as const,
              message: 'Validation rejected payload'
            }
          ]
    })
    if (validationErrors.length > 0) throw new McpInterceptorValidationError(validationErrors)
    return results
  }
  let validations: McpValidationResult[]
  if (direction === 'sending') {
    await runMutations()
    validations = await runValidations()
  } else {
    validations = await runValidations()
    await runMutations()
  }
  return { payload: current, validations, audit }
}

function invocationFor(
  entry: McpInterceptorChainEntry,
  event: string,
  phase: 'request' | 'response',
  payload: unknown
): McpInterceptorInvocation {
  return {
    name: entry.registration.definition.name,
    event,
    phase,
    payload,
    config: entry.overrides?.config,
    timeoutMs: entry.overrides?.timeoutMs
  }
}

function nonBlocking(entry: McpInterceptorChainEntry): boolean {
  return (
    (entry.overrides?.mode ?? entry.registration.definition.mode) === 'audit' ||
    (entry.overrides?.failOpen ?? entry.registration.definition.failOpen ?? false)
  )
}

function failedAudit(entry: McpInterceptorChainEntry, error: unknown): McpInterceptorAuditOutcome {
  return {
    interceptor: entry.registration.definition.name,
    status: 'failed',
    severity:
      (entry.overrides?.failOpen ?? entry.registration.definition.failOpen) ? 'warn' : 'error',
    error
  }
}

function syntheticValidation(
  entry: McpInterceptorChainEntry,
  phase: 'request' | 'response'
): McpValidationResult {
  return {
    interceptor: entry.registration.definition.name,
    type: 'validation',
    phase,
    valid: true
  }
}

function assertNarrowedHooks(entry: McpInterceptorChainEntry): void {
  for (const hook of entry.overrides?.hooks ?? [])
    for (const event of hook.events)
      if (!interceptorMatches(entry.registration.definition, event, hook.phase))
        throw new TypeError('Interceptor hook overrides may only narrow declared hooks')
}
function priority(entry: McpInterceptorChainEntry, phase: 'request' | 'response'): number {
  const hint = entry.overrides?.priorityHint ?? entry.registration.definition.priorityHint ?? 0
  return typeof hint === 'number' ? hint : (hint[phase] ?? 0)
}
function assertSchema(schema: Record<string, unknown>, input: unknown, label: string): void {
  const result = validateJsonSchema(schema, input)
  if (!result.ok) throw new TypeError(`Interceptor ${label} failed schema validation`)
}
function normalizeInterceptorResult(
  definition: McpInterceptorDefinition,
  phase: 'request' | 'response',
  result: unknown
): McpInterceptorResult {
  if (!result || typeof result !== 'object') throw new TypeError('Interceptor result is invalid')
  const candidate = result as Record<string, unknown>
  if (candidate.interceptor !== undefined && candidate.interceptor !== definition.name)
    throw new TypeError('Interceptor result identity is inconsistent')
  if (candidate.type !== undefined && candidate.type !== definition.type)
    throw new TypeError('Interceptor result type is inconsistent')
  if (candidate.phase !== undefined && candidate.phase !== phase)
    throw new TypeError('Interceptor result phase is inconsistent')
  if (
    candidate.durationMs !== undefined &&
    (typeof candidate.durationMs !== 'number' ||
      !Number.isFinite(candidate.durationMs) ||
      candidate.durationMs < 0)
  )
    throw new TypeError('Interceptor result durationMs is invalid')
  if (
    candidate.info !== undefined &&
    (!candidate.info || typeof candidate.info !== 'object' || Array.isArray(candidate.info))
  )
    throw new TypeError('Interceptor result info is invalid')
  if (definition.type === 'validation' && typeof (result as any).valid !== 'boolean')
    throw new TypeError('Validator result is invalid')
  if (definition.type === 'validation') {
    if (
      candidate.severity !== undefined &&
      !['info', 'warn', 'error'].includes(String(candidate.severity))
    )
      throw new TypeError('Validator severity is invalid')
    if (
      candidate.messages !== undefined &&
      (!Array.isArray(candidate.messages) ||
        candidate.messages.some(
          (message) =>
            !message ||
            typeof message !== 'object' ||
            typeof (message as any).message !== 'string' ||
            !['info', 'warn', 'error'].includes((message as any).severity) ||
            ((message as any).path !== undefined && typeof (message as any).path !== 'string')
        ))
    )
      throw new TypeError('Validator messages are invalid')
    if (
      candidate.suggestions !== undefined &&
      (!Array.isArray(candidate.suggestions) ||
        candidate.suggestions.some(
          (suggestion) =>
            !suggestion ||
            typeof suggestion !== 'object' ||
            typeof (suggestion as any).path !== 'string' ||
            !('value' in suggestion)
        ))
    )
      throw new TypeError('Validator suggestions are invalid')
    if (
      candidate.signature !== undefined &&
      (!candidate.signature ||
        typeof candidate.signature !== 'object' ||
        (candidate.signature as any).algorithm !== 'ed25519' ||
        typeof (candidate.signature as any).publicKey !== 'string' ||
        typeof (candidate.signature as any).value !== 'string')
    )
      throw new TypeError('Validator signature is invalid')
  }
  if (
    definition.type === 'mutation' &&
    (typeof (result as any).modified !== 'boolean' || !('payload' in result))
  )
    throw new TypeError('Mutator result is invalid')
  return structuredClone({
    ...candidate,
    interceptor: definition.name,
    type: definition.type,
    phase
  }) as McpInterceptorResult
}

function validPriority(value: McpInterceptorDefinition['priorityHint']): boolean {
  if (value === undefined) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return (
    Object.keys(value).every((key) => key === 'request' || key === 'response') &&
    [value.request, value.response].every(
      (priority) =>
        priority === undefined || (typeof priority === 'number' && Number.isFinite(priority))
    )
  )
}
