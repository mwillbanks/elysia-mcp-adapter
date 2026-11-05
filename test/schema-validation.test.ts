import { expect, spyOn, test } from 'bun:test'
import Ajv2020Import from 'ajv/dist/2020.js'
import { assertTaskInputResponse } from '../src/extensions/tasks/codec.js'
import { validateJsonSchema, validateTransientJsonSchema } from '../src/schema/validate.js'
import { mcpInput, validateInputAnswer } from '../src/transport/input.js'
import type { McpElicitationFormRequest } from '../src/types.js'

const Ajv2020: typeof import('ajv/dist/2020.js').Ajv2020 =
  (Ajv2020Import as any).default ?? Ajv2020Import

function persistedForm(expected: string): McpElicitationFormRequest {
  const request = mcpInput.form({
    message: 'Choose an option',
    requestedSchema: {
      $id: 'https://example.test/form',
      $defs: {
        option: { $id: 'option', type: 'string', const: expected }
      },
      type: 'object',
      properties: { option: { $ref: 'option' } },
      required: ['option']
    }
  })
  return JSON.parse(JSON.stringify(request))
}

test('isolates IDs in rehydrated input forms while preserving local references', () => {
  const first = { action: 'accept', content: { option: 'first' } }
  const second = { action: 'accept', content: { option: 'second' } }

  expect(validateInputAnswer('choice', persistedForm('first'), first)).toEqual(first)
  expect(() => assertTaskInputResponse(persistedForm('first'), first)).not.toThrow()
  expect(() => assertTaskInputResponse(persistedForm('second'), second)).not.toThrow()
  expect(() => assertTaskInputResponse(persistedForm('second'), first)).toThrow(
    'Invalid response for input request'
  )
  expect(() =>
    assertTaskInputResponse(persistedForm('first'), { action: 'accept', content: {} })
  ).toThrow('Invalid response for input request')
})

test('rejects async schemas before validating accepted input', () => {
  const requestedSchema = {
    $async: true,
    type: 'object',
    properties: { choice: { type: 'string' } },
    required: ['choice']
  }
  const issue = {
    ok: false,
    issues: [
      {
        path: '/',
        message: 'Asynchronous JSON Schema validation is unsupported',
        keyword: 'schema'
      }
    ]
  }
  expect(validateJsonSchema(requestedSchema, {})).toEqual(issue)
  expect(validateTransientJsonSchema(requestedSchema, { choice: 'valid' })).toEqual(issue)
  const request = mcpInput.form({ message: 'Choose an option', requestedSchema })
  expect(() => validateInputAnswer('choice', request, { action: 'accept', content: {} })).toThrow(
    'Invalid response for input request'
  )
})

test('reuses equivalent form validators and evicts least recently used entries', () => {
  const compile = spyOn(Ajv2020.prototype, 'compile')
  const detach = spyOn(Ajv2020.prototype, 'removeSchema')
  const schema = (constValue: number) => ({ type: 'number', const: constValue })
  try {
    expect(validateTransientJsonSchema(schema(-1), -1)).toEqual({ ok: true })
    expect(validateTransientJsonSchema(schema(-1), -1)).toEqual({ ok: true })
    expect(compile).toHaveBeenCalledTimes(1)
    expect(detach).toHaveBeenCalledTimes(1)

    for (let value = 0; value < 128; value++) {
      expect(validateTransientJsonSchema(schema(value), value)).toEqual({ ok: true })
    }

    expect(validateTransientJsonSchema(schema(-1), -1)).toEqual({ ok: true })
    expect(compile).toHaveBeenCalledTimes(130)
    expect(detach).toHaveBeenCalledTimes(130)
  } finally {
    detach.mockRestore()
    compile.mockRestore()
  }
})
