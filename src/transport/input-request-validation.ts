import { isRecord } from '../internal.js'
import { isSamplingContentValue } from '../schema/content.js'
import { isValidUri } from '../schema/validate.js'
import type { McpInputRequest } from '../types.js'
import { McpProtocolError } from './protocol-error.js'

type InputMethod = 'elicitation/create' | 'roots/list' | 'sampling/createMessage'
type InputValidator = (params: unknown) => boolean
type ElicitationSchemaValidator = (value: Record<string, unknown>) => boolean

const INPUT_VALIDATORS = new Map<InputMethod, InputValidator>([
  ['roots/list', validRootsParams],
  ['elicitation/create', validElicitationParams],
  ['sampling/createMessage', validSamplingParams]
])
const ELICITATION_SCHEMA_VALIDATORS = new Map<string, ElicitationSchemaValidator>([
  ['boolean', (value) => value.default === undefined || typeof value.default === 'boolean'],
  ['number', validNumericSchema],
  ['integer', validNumericSchema],
  ['string', isPrimitiveStringSchema],
  ['array', isPrimitiveArraySchema]
])
const INCLUDE_CONTEXT_VALUES = new Set(['none', 'thisServer', 'allServers'])
const TOOL_CHOICE_MODES = new Set(['auto', 'required', 'none'])
const METHOD_CAPABILITIES = new Map<string, string>([
  ['elicitation/create', 'elicitation'],
  ['sampling/createMessage', 'sampling'],
  ['roots/list', 'roots']
])

export function assertInputRequestCapabilities(
  requests: Record<string, McpInputRequest>,
  capabilities: Record<string, unknown> | undefined
): void {
  for (const [key, request] of Object.entries(requests)) {
    if (!isRecord(request) || typeof request.method !== 'string') invalidInputRequest(key)
    assertInputRequest(request, key)
    assertDeclaredCapability(request, capabilities)
    assertSamplingCapabilities(request, capabilities)
  }
}

function assertInputRequest(request: Record<string, unknown>, key: string): void {
  const validate =
    typeof request.method === 'string'
      ? INPUT_VALIDATORS.get(request.method as InputMethod)
      : undefined
  if (!validate?.(request.params)) invalidInputRequest(key)
}

function validRootsParams(params: unknown): boolean {
  return params === undefined || isRecord(params)
}

function validElicitationParams(params: unknown): boolean {
  if (!isRecord(params) || typeof params.message !== 'string') return false
  if (params.mode === 'url') return isValidUri(params.url)
  if (params.mode !== undefined && params.mode !== 'form') return false
  return validRequestedSchema(params.requestedSchema)
}

function validRequestedSchema(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'object' || !isRecord(value.properties)) return false
  if (!Object.values(value.properties).every(isPrimitiveElicitationSchema)) return false
  if (value.required !== undefined && !isStringArray(value.required)) return false
  return value.$schema === undefined || typeof value.$schema === 'string'
}

function validSamplingParams(params: unknown): boolean {
  if (!isRecord(params)) return false
  if (!validSamplingCore(params)) return false
  return validSamplingOptions(params)
}

function validSamplingCore(params: Record<string, unknown>): boolean {
  return validSamplingMessages(params.messages) && Number.isSafeInteger(params.maxTokens)
}

function validSamplingOptions(params: Record<string, unknown>): boolean {
  if (!optionalString(params.systemPrompt) || !validIncludeContext(params.includeContext))
    return false
  if (!optionalFiniteNumber(params.temperature) || !optionalStringArray(params.stopSequences))
    return false
  if (params.metadata !== undefined && !isRecord(params.metadata)) return false
  return (
    isModelPreferences(params.modelPreferences) &&
    isSamplingTools(params.tools) &&
    isToolChoice(params.toolChoice)
  )
}

function validSamplingMessages(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.every((message) => {
    if (!isRecord(message)) return false
    if (message.role !== 'user' && message.role !== 'assistant') return false
    return isSamplingContentValue(message.content)
  })
}

function validIncludeContext(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && INCLUDE_CONTEXT_VALUES.has(value))
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value)
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isPrimitiveElicitationSchema(value: unknown): boolean {
  if (!isRecord(value) || 'properties' in value) return false
  if (!validSchemaDescription(value)) return false
  const validate =
    typeof value.type === 'string' ? ELICITATION_SCHEMA_VALIDATORS.get(value.type) : undefined
  return validate?.(value) ?? false
}

function validSchemaDescription(value: Record<string, unknown>): boolean {
  if (value.title !== undefined && typeof value.title !== 'string') return false
  return value.description === undefined || typeof value.description === 'string'
}

function validNumericSchema(value: Record<string, unknown>): boolean {
  return (
    optionalFiniteNumber(value.default) &&
    optionalFiniteNumber(value.minimum) &&
    optionalFiniteNumber(value.maximum)
  )
}

function isPrimitiveStringSchema(value: Record<string, unknown>): boolean {
  if (!optionalString(value.default)) return false
  if (value.enum !== undefined) return validEnumSchema(value)
  if (value.oneOf !== undefined) return isTitledEnumChoices(value.oneOf)
  return validStringConstraints(value)
}

function validEnumSchema(value: Record<string, unknown>): boolean {
  return (
    isStringArray(value.enum) && (value.enumNames === undefined || isStringArray(value.enumNames))
  )
}

function validStringConstraints(value: Record<string, unknown>): boolean {
  const formats = [undefined, 'date', 'date-time', 'email', 'uri']
  return (
    formats.includes(value.format as string | undefined) &&
    optionalSafeInteger(value.minLength) &&
    optionalSafeInteger(value.maxLength)
  )
}

function isPrimitiveArraySchema(value: Record<string, unknown>): boolean {
  if (!isRecord(value.items)) return false
  if (!optionalStringArray(value.default)) return false
  if (!optionalSafeInteger(value.minItems) || !optionalSafeInteger(value.maxItems)) return false
  if (value.items.enum !== undefined) {
    return value.items.type === 'string' && isStringArray(value.items.enum)
  }
  return isTitledEnumChoices(value.items.anyOf)
}

function isTitledEnumChoices(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.every((choice) => {
    if (!isRecord(choice)) return false
    return typeof choice.const === 'string' && typeof choice.title === 'string'
  })
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function optionalSafeInteger(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value)
}

function isModelPreferences(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || !validModelHints(value.hints)) return false
  return ['costPriority', 'speedPriority', 'intelligencePriority'].every((key) =>
    validPriority(value[key])
  )
}

function validModelHints(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  return value.every(
    (hint) => isRecord(hint) && (hint.name === undefined || typeof hint.name === 'string')
  )
}

function validPriority(value: unknown): boolean {
  if (value === undefined) return true
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isSamplingTools(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  return value.every((tool) => {
    if (!isRecord(tool) || typeof tool.name !== 'string') return false
    return isRecord(tool.inputSchema) && tool.inputSchema.type === 'object'
  })
}

function isToolChoice(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || value.mode === undefined) return isRecord(value)
  return typeof value.mode === 'string' && TOOL_CHOICE_MODES.has(value.mode)
}

function assertDeclaredCapability(
  request: Record<string, unknown>,
  capabilities: Record<string, unknown> | undefined
): void {
  const capability = capabilityForMethod(request.method)
  const declared = capability ? capabilities?.[capability] : undefined
  if (capability && isRecord(declared) && supportsRequestedMode(request, declared)) return
  throw new McpProtocolError(
    -32021,
    `Missing required client capability: ${capability ?? request.method}`,
    400,
    { requiredCapabilities: requiredCapability(request, capability) }
  )
}

function capabilityForMethod(method: unknown): string | undefined {
  return typeof method === 'string' ? METHOD_CAPABILITIES.get(method) : undefined
}

function supportsRequestedMode(
  request: Record<string, unknown>,
  capability: Record<string, unknown>
): boolean {
  if (request.method !== 'elicitation/create' || !isRecord(request.params)) return true
  const mode = request.params.mode === 'url' ? 'url' : 'form'
  if (mode === 'url') return isRecord(capability.url)
  if (isRecord(capability.form)) return true
  return capability.form === undefined && capability.url === undefined
}

function requiredCapability(
  request: Record<string, unknown>,
  capability: string | undefined
): Record<string, unknown> {
  if (!capability) return {}
  if (request.method !== 'elicitation/create' || !isRecord(request.params)) {
    return { [capability]: {} }
  }
  const mode = request.params.mode === 'url' ? 'url' : 'form'
  return { elicitation: { [mode]: {} } }
}

function assertSamplingCapabilities(
  request: Record<string, unknown>,
  capabilities: Record<string, unknown> | undefined
): void {
  if (request.method !== 'sampling/createMessage' || !isRecord(request.params)) return
  const declared = capabilities?.sampling
  assertSamplingToolsCapability(request.params, declared)
  assertSamplingContextCapability(request.params, declared)
}

function assertSamplingToolsCapability(params: Record<string, unknown>, declared: unknown): void {
  const usesTools = params.tools !== undefined || params.toolChoice !== undefined
  if (!usesTools || (isRecord(declared) && isRecord(declared.tools))) return
  throw new McpProtocolError(-32021, 'Missing required client capability: sampling.tools', 400, {
    requiredCapabilities: { sampling: { tools: {} } }
  })
}

function assertSamplingContextCapability(params: Record<string, unknown>, declared: unknown): void {
  const usesContext = params.includeContext !== undefined && params.includeContext !== 'none'
  if (!usesContext || (isRecord(declared) && isRecord(declared.context))) return
  throw new McpProtocolError(-32021, 'Missing required client capability: sampling.context', 400, {
    requiredCapabilities: { sampling: { context: {} } }
  })
}

function invalidInputRequest(key: string): never {
  throw new McpProtocolError(-32603, `Invalid input request: ${key}`)
}
