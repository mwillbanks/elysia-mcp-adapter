import { validateJsonSchema } from '../../schema/validate.js'
import { canonicalJson } from './cursor.js'
import type {
  McpEventDefinition,
  McpEventDescriptor,
  McpEventOccurrence,
  McpEventPollResult
} from './types.js'

const DELIVERY = new Set(['poll', 'push', 'webhook'])

export function assertEventDefinition(value: McpEventDefinition): void {
  if (!value || typeof value !== 'object') throw new TypeError('Event definition is invalid')
  if (typeof value.name !== 'string' || value.name.length === 0)
    throw new TypeError('Event name is required')
  if (typeof value.description !== 'string' || value.description.length === 0)
    throw new TypeError('Event description is required')
  if (
    !Array.isArray(value.delivery) ||
    value.delivery.length === 0 ||
    value.delivery.some((mode) => !DELIVERY.has(mode)) ||
    new Set(value.delivery).size !== value.delivery.length
  )
    throw new TypeError('Event delivery modes are invalid')
  assertSchema(value.inputSchema, 'inputSchema')
  assertSchema(value.payloadSchema, 'payloadSchema')
  if (value._meta !== undefined && !isObject(value._meta))
    throw new TypeError('Event _meta must be an object')
}

export function assertEventArguments(
  definition: McpEventDefinition,
  arguments_: unknown
): asserts arguments_ is Record<string, unknown> {
  if (!isObject(arguments_)) throw new TypeError('Event arguments must be an object')
  const validation = validateJsonSchema(definition.inputSchema, arguments_)
  if (!validation.ok) throw new TypeError('Event arguments do not match inputSchema')
}

export function assertEventPollResult(
  definition: McpEventDefinition,
  result: McpEventPollResult,
  limit: number
): void {
  if (!isObject(result) || !Array.isArray(result.events))
    throw new TypeError('Event provider returned an invalid poll result')
  if (result.events.length > limit) throw new TypeError('Event provider exceeded maxEvents')
  if (result.cursor !== null && typeof result.cursor !== 'string')
    throw new TypeError('Event provider returned an invalid cursor')
  if (result.truncated !== undefined && typeof result.truncated !== 'boolean')
    throw new TypeError('Event provider returned an invalid truncated flag')
  if (result.hasMore !== undefined && typeof result.hasMore !== 'boolean')
    throw new TypeError('Event provider returned an invalid hasMore flag')
  if (
    result.nextPollMs !== undefined &&
    (!Number.isSafeInteger(result.nextPollMs) || result.nextPollMs < 0)
  )
    throw new TypeError('Event provider returned an invalid nextPollMs')
  if (result.terminated !== undefined) {
    if (
      !isObject(result.terminated) ||
      !Number.isSafeInteger(result.terminated.code) ||
      typeof result.terminated.message !== 'string' ||
      (result.terminated.data !== undefined && !isObject(result.terminated.data)) ||
      Object.keys(result.terminated).some(
        (key) => key !== 'code' && key !== 'message' && key !== 'data'
      )
    )
      throw new TypeError('Event provider returned an invalid termination error')
  }
  for (const occurrence of result.events) assertEventOccurrence(definition, occurrence)
}

export function assertEventOccurrence(
  definition: McpEventDefinition,
  occurrence: McpEventOccurrence
): void {
  if (!isObject(occurrence)) throw new TypeError('Event occurrence is invalid')
  if (typeof occurrence.eventId !== 'string' || occurrence.eventId.length === 0)
    throw new TypeError('Event occurrence eventId is invalid')
  if (occurrence.name !== definition.name)
    throw new TypeError('Event occurrence name does not match its definition')
  if (typeof occurrence.timestamp !== 'string' || !isIso8601DateTime(occurrence.timestamp))
    throw new TypeError('Event occurrence timestamp is invalid')
  if (!isObject(occurrence.data)) throw new TypeError('Event occurrence data must be an object')
  const validation = validateJsonSchema(definition.payloadSchema, occurrence.data)
  if (!validation.ok) throw new TypeError('Event occurrence data does not match payloadSchema')
  if (
    occurrence.cursor !== undefined &&
    occurrence.cursor !== null &&
    typeof occurrence.cursor !== 'string'
  )
    throw new TypeError('Event occurrence cursor is invalid')
  if (occurrence._meta !== undefined && !isObject(occurrence._meta))
    throw new TypeError('Event occurrence _meta is invalid')
}

const ISO_8601_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/

function isIso8601DateTime(value: string): boolean {
  const match = ISO_8601_DATE_TIME.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[8] === undefined ? 0 : Number(match[8])
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9])

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false
  if (offsetHour > 23 || offsetMinute > 59) return false

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const maximumDay = daysInMonth[month - 1]
  return maximumDay !== undefined && day >= 1 && day <= maximumDay
}

export function eventDescriptor(definition: McpEventDefinition): McpEventDescriptor {
  const {
    authorization: _authorization,
    authorize: _authorize,
    onSubscribe: _onSubscribe,
    onUnsubscribe: _onUnsubscribe,
    ...descriptor
  } = definition
  return structuredClone(descriptor) as McpEventDescriptor
}

export function snapshotEventDefinition(definition: McpEventDefinition): McpEventDefinition {
  return {
    ...structuredClone(eventDescriptor(definition)),
    authorization: definition.authorization ? structuredClone(definition.authorization) : undefined,
    authorize: definition.authorize,
    onSubscribe: definition.onSubscribe,
    onUnsubscribe: definition.onUnsubscribe
  }
}

export function incompatibleEventSchema(
  previous: McpEventDefinition,
  current: McpEventDefinition
): 'inputSchema' | 'payloadSchema' | null {
  if (!isAdditiveSchema(previous.inputSchema, current.inputSchema, 'input')) return 'inputSchema'
  if (!isAdditiveSchema(previous.payloadSchema, current.payloadSchema, 'output'))
    return 'payloadSchema'
  return null
}

function isAdditiveSchema(
  previous: unknown,
  current: unknown,
  direction: 'input' | 'output'
): boolean {
  if (schemaValueEqual(previous, current)) return true
  if (previous === false) return current === true
  if (previous === true || !isObject(previous) || !isObject(current)) return false

  const keys = new Set([...Object.keys(previous), ...Object.keys(current)])
  for (const key of keys) {
    const before = previous[key]
    const after = current[key]
    if (schemaValueEqual(before, after)) continue

    if (SCHEMA_ANNOTATIONS.has(key)) continue
    if (key === 'properties') {
      if (!isAdditiveProperties(before, after, direction)) return false
      continue
    }
    if (key === 'required') {
      if (!isAdditiveRequired(before, after, direction)) return false
      continue
    }
    if (key === 'enum') {
      if (!isEnumWidening(before, after)) return false
      continue
    }
    if (key === 'additionalProperties' || key === 'items') {
      if (!isRelaxedSubschema(before, after, direction)) return false
      continue
    }
    if (key === 'patternProperties') {
      if (!isAdditivePatternProperties(before, after, direction)) return false
      continue
    }
    if (LOWER_BOUND_KEYWORDS.has(key)) {
      if (!isRelaxedLowerBound(before, after)) return false
      continue
    }
    if (UPPER_BOUND_KEYWORDS.has(key)) {
      if (!isRelaxedUpperBound(before, after)) return false
      continue
    }
    if (key === 'uniqueItems') {
      if (!(before === true && (after === false || after === undefined))) return false
      continue
    }
    if (key === 'pattern' || key === 'format') {
      if (after !== undefined) return false
      continue
    }

    // Changed composition, conditional, reference, identity, and unknown assertion
    // keywords fail closed because their compatibility cannot be inferred safely.
    return false
  }
  return true
}

function schemaValueEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right
  return canonicalJson(left) === canonicalJson(right)
}

const SCHEMA_ANNOTATIONS = new Set([
  'title',
  'description',
  '$comment',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly'
])
const LOWER_BOUND_KEYWORDS = new Set([
  'minimum',
  'exclusiveMinimum',
  'minLength',
  'minItems',
  'minProperties',
  'minContains'
])
const UPPER_BOUND_KEYWORDS = new Set([
  'maximum',
  'exclusiveMaximum',
  'maxLength',
  'maxItems',
  'maxProperties',
  'maxContains'
])

function isAdditiveProperties(
  previous: unknown,
  current: unknown,
  direction: 'input' | 'output'
): boolean {
  const previousProperties = previous === undefined ? {} : previous
  if (!isObject(previousProperties) || !isObject(current)) return false
  for (const [name, schema] of Object.entries(previousProperties)) {
    const replacement = current[name]
    if (!isAdditiveSchema(schema, replacement, direction)) return false
  }
  return true
}

function isAdditiveRequired(
  previous: unknown,
  current: unknown,
  direction: 'input' | 'output'
): boolean {
  const before = stringSet(previous)
  const after = stringSet(current)
  if (!before || !after) return false
  if (direction === 'input') return [...after].every((name) => before.has(name))
  return before.size === after.size && [...before].every((name) => after.has(name))
}

function isEnumWidening(previous: unknown, current: unknown): boolean {
  if (!Array.isArray(previous)) return false
  if (current === undefined) return true
  if (!Array.isArray(current)) return false
  const values = new Set(current.map((value) => canonicalJson(value)))
  return previous.every((value) => values.has(canonicalJson(value)))
}

function isRelaxedSubschema(
  previous: unknown,
  current: unknown,
  direction: 'input' | 'output'
): boolean {
  if (previous === false) return current !== false
  if (previous === undefined || previous === true) return current === undefined || current === true
  if (!isObject(previous)) return false
  if (current === undefined || current === true) return true
  return isObject(current) && isAdditiveSchema(previous, current, direction)
}

function isAdditivePatternProperties(
  previous: unknown,
  current: unknown,
  direction: 'input' | 'output'
): boolean {
  if (!isObject(previous) || !isObject(current)) return false
  if (Object.keys(previous).length !== Object.keys(current).length) return false
  for (const [pattern, schema] of Object.entries(previous)) {
    const replacement = current[pattern]
    if (!isAdditiveSchema(schema, replacement, direction)) return false
  }
  return true
}

function isRelaxedLowerBound(previous: unknown, current: unknown): boolean {
  if (typeof previous !== 'number') return false
  return current === undefined || (typeof current === 'number' && current <= previous)
}

function isRelaxedUpperBound(previous: unknown, current: unknown): boolean {
  if (typeof previous !== 'number') return false
  return current === undefined || (typeof current === 'number' && current >= previous)
}

function stringSet(value: unknown): Set<string> | null {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null
  return new Set(value)
}

function assertSchema(value: unknown, label: string): void {
  if (!isObject(value)) throw new TypeError(`Event ${label} must be a JSON Schema object`)
  const result = validateJsonSchema(value, {})
  if (!result.ok && result.issues?.some(({ keyword }) => keyword === 'schema'))
    throw new TypeError(`Event ${label} is invalid`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
