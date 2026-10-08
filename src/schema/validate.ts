import type { ValidateFunction } from 'ajv'
import Ajv2020Import from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'
import type { JsonSchema } from '../types.js'

const Ajv2020 = (Ajv2020Import as any).default ?? Ajv2020Import
const addFormats = (addFormatsImport as any).default ?? addFormatsImport

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  allowUnionTypes: true
})

addFormats(ajv)
ajv.addFormat('numeric', true)
ajv.addFormat('boolean', true)
ajv.addFormat('ObjectString', true)
ajv.addFormat('ArrayString', true)

const cache = new WeakMap<object, ValidateFunction>()
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
  try {
    const validate = getValidator(schema)
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

  const validate = ajv.compile(schema) as ValidateFunction
  cache.set(schema, validate)
  return validate
}
