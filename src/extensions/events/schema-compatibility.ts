import { canonicalJson } from './cursor.js'

type SchemaDirection = 'input' | 'output'

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

export function isAdditiveSchema(
  previous: unknown,
  current: unknown,
  direction: SchemaDirection
): boolean {
  if (schemaValueEqual(previous, current)) return true
  if (previous === false) return current === true
  if (previous === true || !isObject(previous) || !isObject(current)) return false
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])].every((key) =>
    isCompatibleKeyword(key, previous[key], current[key], direction)
  )
}

function isCompatibleKeyword(
  key: string,
  before: unknown,
  after: unknown,
  direction: SchemaDirection
): boolean {
  if (schemaValueEqual(before, after) || SCHEMA_ANNOTATIONS.has(key)) return true
  const structural = structuralKeywordCompatibility(key, before, after, direction)
  if (structural !== undefined) return structural
  const bounded = boundedKeywordCompatibility(key, before, after)
  if (bounded !== undefined) return bounded
  return simpleKeywordCompatibility(key, before, after)
}

function structuralKeywordCompatibility(
  key: string,
  before: unknown,
  after: unknown,
  direction: SchemaDirection
): boolean | undefined {
  if (key === 'properties') return isAdditiveProperties(before, after, direction)
  if (key === 'required') return isAdditiveRequired(before, after, direction)
  if (key === 'enum') return isEnumWidening(before, after)
  if (key === 'additionalProperties' || key === 'items')
    return isRelaxedSubschema(before, after, direction)
  if (key === 'patternProperties') return isAdditivePatternProperties(before, after, direction)
  return undefined
}

function boundedKeywordCompatibility(
  key: string,
  before: unknown,
  after: unknown
): boolean | undefined {
  if (LOWER_BOUND_KEYWORDS.has(key)) return isRelaxedLowerBound(before, after)
  if (UPPER_BOUND_KEYWORDS.has(key)) return isRelaxedUpperBound(before, after)
  return undefined
}

function simpleKeywordCompatibility(key: string, before: unknown, after: unknown): boolean {
  if (key === 'uniqueItems') return before === true && (after === false || after === undefined)
  if (key === 'pattern' || key === 'format') return after === undefined
  return false
}

function schemaValueEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right
  return canonicalJson(left) === canonicalJson(right)
}

function isAdditiveProperties(
  previous: unknown,
  current: unknown,
  direction: SchemaDirection
): boolean {
  const previousProperties = previous === undefined ? {} : previous
  return (
    isObject(previousProperties) &&
    isObject(current) &&
    Object.entries(previousProperties).every(([name, schema]) =>
      isAdditiveSchema(schema, current[name], direction)
    )
  )
}

function isAdditiveRequired(
  previous: unknown,
  current: unknown,
  direction: SchemaDirection
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
  direction: SchemaDirection
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
  direction: SchemaDirection
): boolean {
  if (!isObject(previous) || !isObject(current)) return false
  const entries = Object.entries(previous)
  return (
    entries.length === Object.keys(current).length &&
    entries.every(([pattern, schema]) => isAdditiveSchema(schema, current[pattern], direction))
  )
}

function isRelaxedLowerBound(previous: unknown, current: unknown): boolean {
  return (
    typeof previous === 'number' &&
    (current === undefined || (typeof current === 'number' && current <= previous))
  )
}

function isRelaxedUpperBound(previous: unknown, current: unknown): boolean {
  return (
    typeof previous === 'number' &&
    (current === undefined || (typeof current === 'number' && current >= previous))
  )
}

function stringSet(value: unknown): Set<string> | null {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null
  return new Set(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
