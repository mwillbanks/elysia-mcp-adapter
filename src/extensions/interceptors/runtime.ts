import { validateJsonSchema } from '../../schema/validate.js'
import type { McpInvocationContext } from '../../types.js'
import { assertInterceptorDefinition } from './definition-validation.js'
import { normalizeInterceptorResult } from './result-validation.js'
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

export { assertInterceptorDefinition } from './definition-validation.js'

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
  validateInterceptorInvocation(registration, invocation)
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

function validateInterceptorInvocation(
  registration: McpInterceptorRegistration,
  invocation: McpInterceptorInvocation
): void {
  assertInterceptorDefinition(registration.definition)
  if (invocation.event.length === 0) throw new TypeError('Interceptor event is required')
  if (!interceptorMatches(registration.definition, invocation.event, invocation.phase)) {
    throw new TypeError('Interceptor does not declare this event and phase')
  }
  if (invocation.timeoutMs !== undefined && !validTimeout(invocation.timeoutMs)) {
    throw new TypeError('Interceptor timeoutMs must be positive')
  }
  validateInvocationSchema(registration, 'configSchema', invocation.config ?? {})
  validateInvocationSchema(registration, 'payloadSchema', invocation.payload)
}

function validTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function validateInvocationSchema(
  registration: McpInterceptorRegistration,
  field: 'configSchema' | 'payloadSchema',
  input: unknown
): void {
  const schema = registration.definition[field]
  if (!schema) return
  const label = field === 'configSchema' ? 'configuration' : 'payload'
  const reason = field === 'configSchema' ? 'Configuration invalid' : 'Payload invalid'
  try {
    assertSchema(schema, input, label)
  } catch (cause) {
    throw new McpInterceptorExecutionError(registration.definition.name, reason, { cause })
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
