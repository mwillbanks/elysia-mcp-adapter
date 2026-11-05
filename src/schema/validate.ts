import type { ValidateFunction } from 'ajv'
import Ajv2020Import from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'
import type { JsonSchema } from '../types.js'

const Ajv2020: typeof import('ajv/dist/2020.js').Ajv2020 =
  (Ajv2020Import as any).default ?? Ajv2020Import
const addFormats = (addFormatsImport as any).default ?? addFormatsImport

function createCompiler() {
  const compiler = new Ajv2020({
    allErrors: true,
    strict: false,
    allowUnionTypes: true
  })
  addFormats(compiler)
  compiler.addFormat('numeric', true)
  compiler.addFormat('boolean', true)
  compiler.addFormat('ObjectString', true)
  compiler.addFormat('ArrayString', true)
  return compiler
}

const ajv = createCompiler()
const cache = new WeakMap<object, ValidateFunction>()
const transientCache = new Map<string, ValidateFunction>()
const MAX_TRANSIENT_VALIDATORS = 128
const MAX_TRANSIENT_SCHEMA_LENGTH = 16_384
const URI_SCHEMA: JsonSchema = Object.freeze({ type: 'string', format: 'uri' })

export interface SchemaValidationResult {
  ok: boolean
  issues?: Array<{
    path: string
    message: string
    keyword: string
  }>
}

export function validateJsonSchema(schema: JsonSchema, input: unknown): SchemaValidationResult {
  return validateSchema(input, () => getValidator(schema))
}

export function validateTransientJsonSchema(
  schema: JsonSchema,
  input: unknown
): SchemaValidationResult {
  return validateSchema(input, () => getTransientValidator(schema))
}

function validateSchema(
  input: unknown,
  getValidator: () => ValidateFunction
): SchemaValidationResult {
  try {
    const validate = getValidator()
    const ok = validate(input)

    if (ok) return { ok: true }

    return {
      ok: false,
      issues: (validate.errors ?? []).map((error) => ({
        path: error.instancePath || '/',
        message: error.message ?? 'invalid value',
        keyword: error.keyword
      }))
    }
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: '/',
          message: error instanceof Error ? error.message : 'schema validation failed',
          keyword: 'schema'
        }
      ]
    }
  }
}

export function isValidUri(input: unknown): input is string {
  return typeof input === 'string' && validateJsonSchema(URI_SCHEMA, input).ok
}

function getValidator(schema: JsonSchema): ValidateFunction {
  const cached = cache.get(schema)
  if (cached) return cached

  const validate = compileSync(ajv, schema)
  cache.set(schema, validate)
  return validate
}

function getTransientValidator(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema)
  const cacheable = key.length <= MAX_TRANSIENT_SCHEMA_LENGTH
  if (cacheable) {
    const cached = transientCache.get(key)
    if (cached) {
      transientCache.delete(key)
      transientCache.set(key, cached)
      return cached
    }
  }

  // Ajv also retains nested IDs and anchors. Give each new form its own reference scope.
  const compiler = createCompiler()
  try {
    const validate = compileSync(compiler, JSON.parse(key))
    if (cacheable) {
      const oldest = transientCache.keys().next().value
      if (transientCache.size >= MAX_TRANSIENT_VALIDATORS && oldest !== undefined) {
        transientCache.delete(oldest)
      }
      transientCache.set(key, validate)
    }
    return validate
  } finally {
    compiler.removeSchema()
  }
}

function compileSync(compiler: InstanceType<typeof Ajv2020>, schema: JsonSchema): ValidateFunction {
  const validate = compiler.compile(schema)
  if ('$async' in validate && validate.$async) {
    throw new TypeError('Asynchronous JSON Schema validation is unsupported')
  }
  return validate
}
