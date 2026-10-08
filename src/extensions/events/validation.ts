import { validateJsonSchema } from '../../schema/validate.js'
import { isAdditiveSchema } from './schema-compatibility.js'
import type {
  McpEventDefinition,
  McpEventDescriptor,
  McpEventOccurrence,
  McpEventPollResult
} from './types.js'

const DELIVERY = new Set(['poll', 'push', 'webhook'])
const ISO_8601_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/

export function assertEventDefinition(value: McpEventDefinition): void {
  if (!value || typeof value !== 'object') throw new TypeError('Event definition is invalid')
  if (typeof value.name !== 'string' || value.name.length === 0)
    throw new TypeError('Event name is required')
  if (typeof value.description !== 'string' || value.description.length === 0)
    throw new TypeError('Event description is required')
  if (!validDeliveryModes(value.delivery)) throw new TypeError('Event delivery modes are invalid')
  assertSchema(value.inputSchema, 'inputSchema')
  assertSchema(value.payloadSchema, 'payloadSchema')
  if (value._meta !== undefined && !isObject(value._meta))
    throw new TypeError('Event _meta must be an object')
}

function validDeliveryModes(value: unknown): value is McpEventDefinition['delivery'] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((mode) => DELIVERY.has(mode)) &&
    new Set(value).size === value.length
  )
}

export function assertEventArguments(
  definition: McpEventDefinition,
  arguments_: unknown
): asserts arguments_ is Record<string, unknown> {
  if (!isObject(arguments_)) throw new TypeError('Event arguments must be an object')
  if (!validateJsonSchema(definition.inputSchema, arguments_).ok)
    throw new TypeError('Event arguments do not match inputSchema')
}

export function assertEventPollResult(
  definition: McpEventDefinition,
  result: McpEventPollResult,
  limit: number
): void {
  if (!isObject(result) || !Array.isArray(result.events))
    throw new TypeError('Event provider returned an invalid poll result')
  assertPollResultPage(result, limit)
  if (result.terminated !== undefined) assertTerminationError(result.terminated)
  for (const occurrence of result.events) assertEventOccurrence(definition, occurrence)
}

function assertPollResultPage(result: McpEventPollResult, limit: number): void {
  if (result.events.length > limit) throw new TypeError('Event provider exceeded maxEvents')
  if (result.cursor !== null && typeof result.cursor !== 'string')
    throw new TypeError('Event provider returned an invalid cursor')
  assertPollResultFlags(result)
  if (
    result.nextPollMs !== undefined &&
    (!Number.isSafeInteger(result.nextPollMs) || result.nextPollMs < 0)
  )
    throw new TypeError('Event provider returned an invalid nextPollMs')
}

function assertPollResultFlags(result: McpEventPollResult): void {
  if (result.truncated !== undefined && typeof result.truncated !== 'boolean')
    throw new TypeError('Event provider returned an invalid truncated flag')
  if (result.hasMore !== undefined && typeof result.hasMore !== 'boolean')
    throw new TypeError('Event provider returned an invalid hasMore flag')
}

function assertTerminationError(value: unknown): void {
  if (!isObject(value)) throw new TypeError('Event provider returned an invalid termination error')
  const valid =
    Number.isSafeInteger(value.code) &&
    typeof value.message === 'string' &&
    (value.data === undefined || isObject(value.data)) &&
    Object.keys(value).every((key) => key === 'code' || key === 'message' || key === 'data')
  if (!valid) throw new TypeError('Event provider returned an invalid termination error')
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
  assertOccurrencePayload(definition, occurrence)
}

function assertOccurrencePayload(
  definition: McpEventDefinition,
  occurrence: McpEventOccurrence
): void {
  if (!isObject(occurrence.data)) throw new TypeError('Event occurrence data must be an object')
  if (!validateJsonSchema(definition.payloadSchema, occurrence.data).ok)
    throw new TypeError('Event occurrence data does not match payloadSchema')
  if (
    occurrence.cursor !== undefined &&
    occurrence.cursor !== null &&
    typeof occurrence.cursor !== 'string'
  )
    throw new TypeError('Event occurrence cursor is invalid')
  if (occurrence._meta !== undefined && !isObject(occurrence._meta))
    throw new TypeError('Event occurrence _meta is invalid')
}

function isIso8601DateTime(value: string): boolean {
  const match = ISO_8601_DATE_TIME.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = Number(match[8] ?? 0)
  const offsetMinute = Number(match[9] ?? 0)
  if (!validClock(month, hour, minute, second, offsetHour, offsetMinute)) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

function validClock(
  month: number,
  hour: number,
  minute: number,
  second: number,
  offsetHour: number,
  offsetMinute: number
): boolean {
  return (
    month >= 1 &&
    month <= 12 &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  )
}

function daysInMonth(year: number, month: number): number {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
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

function assertSchema(value: unknown, label: string): void {
  if (!isObject(value)) throw new TypeError(`Event ${label} must be a JSON Schema object`)
  const result = validateJsonSchema(value, {})
  if (!result.ok && result.issues?.some(({ keyword }) => keyword === 'schema'))
    throw new TypeError(`Event ${label} is invalid`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
