import { describe, expect, test } from 'bun:test'
import {
  applyLanguageResponseHeaders,
  contentLanguageOf,
  localizeLanguageProgress,
  localizeLanguageResult
} from '../src/transport/language-response.js'
import {
  MCP_ACCEPT_LANGUAGE_META_KEY,
  MCP_CONTENT_LANGUAGE_META_KEY,
  type McpLanguageDisplayContext,
  type McpLanguageOptions,
  normalizeLanguageOptions,
  resolveHttpRequestLanguage,
  resolveRequestLanguage
} from '../src/transport/language.js'

const language = normalizeLanguageOptions({
  supportedLanguages: ['en-US', 'fr', 'fr-CA', 'de', 'zh-Hant-CN', 'en-US-u-ca-gregory'],
  defaultLanguage: 'en-us'
})

function expectHeaderMismatch(value: unknown, header: string | null): void {
  let error: unknown
  try {
    resolveRequestLanguage(language, value, header)
  } catch (cause) {
    error = cause
  }
  expect(error).toMatchObject({ code: -32020, status: 400 })
}

describe('SEP-2792 language negotiation', () => {
  test.each([
    ['de;q=0.3,FR-ca;q=0.9,fr;q=0.8', 'fr-CA'],
    ['fr-CH, de;q=0.8', 'fr'],
    ['de;q=0.7, fr;q=0.7', 'de'],
    ['fr;q=0.7, de;q=0.7', 'fr'],
    ['fr;q=0.1, FR;q=1, de;q=0.8', 'de'],
    ['fr;q=0, fr-CA;q=0.8, de;q=0.5', 'fr-CA'],
    ['fr-CH, fr;q=0, de;q=0.5', 'de'],
    ['fr;q=0, FR, de;q=0.5', 'de'],
    ['en-US-u-ca-gregory-x-test', 'en-US-u-ca-gregory'],
    ['zh-Hant-CN-x-private1-private2', 'zh-Hant-CN'],
    ['*, fr;q=0.2', 'fr'],
    ['it, *;q=0.2', 'en-US'],
    ['it', 'en-US'],
    ['fr;q=0, *;q=0', 'en-US'],
    [', fr;Q=1.000, , de;q=0.,', 'fr']
  ])('uses RFC lookup for %s', (preference, expected) => {
    expect(resolveRequestLanguage(language, preference, preference)).toEqual({
      acceptLanguage: preference,
      contentLanguage: expected,
      mirrored: true
    })
  })

  test('uses configured default without selecting a more specific tag during lookup', () => {
    const specific = normalizeLanguageOptions({
      supportedLanguages: ['en-US', 'de-CH-1996', 'de'],
      defaultLanguage: 'en-US'
    })
    expect(resolveRequestLanguage(specific, 'de-CH', null)?.contentLanguage).toBe('de')
  })

  test('ignores opt-out, omitted, and bare-header preferences', () => {
    expect(resolveRequestLanguage(undefined, 'fr', 'de')).toBeUndefined()
    expect(resolveRequestLanguage(language, undefined, 'fr')).toBeUndefined()
    expect(resolveRequestLanguage(language, undefined, null)).toBeUndefined()
    expect(resolveRequestLanguage(language, 'fr', null)).toEqual({
      acceptLanguage: 'fr',
      contentLanguage: 'fr',
      mirrored: false
    })
  })

  test.each([
    'fr;q=1.001',
    'fr;q=.9',
    'fr;q=0.0001',
    'fr;q= 0.9',
    'fr;q=0.8;q=0.7',
    'fr;q=1e0',
    'fr;q=0x1',
    'fr-*-CA',
    'fr\n',
    'de,\u00a0fr',
    'fr,Englishlanguage',
    'fr' + ' '.repeat(4096),
    'fr,'.repeat(101)
  ])('ignores malformed or excessive canonical preference %p after checking agreement', (value) => {
    expect(resolveRequestLanguage(language, value, value)).toBeUndefined()
    expect(resolveRequestLanguage(language, value, null)).toBeUndefined()
    expectHeaderMismatch(value, 'de')
  })

  test.each([
    ['en-US', 'en-us'],
    ['en-US,en;q=0.9', 'en-US, en;q=0.9'],
    ['en;q=0.9', 'en;q=0.900'],
    ['en,fr', 'fr,en'],
    ['fr ', 'fr'],
    [null, 'fr']
  ])('rejects different decoded and HTTP values %p and %p', (value, header) => {
    expectHeaderMismatch(value, header)
  })

  test('uses the complete parsed HTTP field, including repeated field lines', () => {
    const headers = new Headers()
    headers.append('Accept-Language', ' fr-CA ')
    headers.append('Accept-Language', '\tfr;q=0.9 ')
    const header = headers.get('Accept-Language')
    expect(resolveRequestLanguage(language, 'fr-CA, fr;q=0.9', header)?.contentLanguage).toBe(
      'fr-CA'
    )
    expectHeaderMismatch('fr-CA', header)
  })

  test('validates configured tags, uniqueness and default membership', () => {
    expect(() =>
      normalizeLanguageOptions({ supportedLanguages: [], defaultLanguage: 'en' })
    ).toThrow('at least one supported language')
    expect(() =>
      normalizeLanguageOptions({ supportedLanguages: ['en-US', 'en-us'], defaultLanguage: 'en' })
    ).toThrow('must be unique')
    expect(() =>
      normalizeLanguageOptions({ supportedLanguages: ['en'], defaultLanguage: 'fr' })
    ).toThrow('default language must be supported')
    for (const malformed of [
      '*',
      'en,fr',
      'en_US',
      'en--US',
      'Kelvin',
      'en-u-ca-u-nu',
      'en-abcde-abcde'
    ]) {
      expect(() =>
        normalizeLanguageOptions({ supportedLanguages: [malformed], defaultLanguage: malformed })
      ).toThrow('well-formed BCP 47 tags')
    }
    const privateUse = normalizeLanguageOptions({
      supportedLanguages: ['x-local', 'en-GB-oed'],
      defaultLanguage: 'x-local'
    })
    expect(resolveRequestLanguage(privateUse, 'en-gb-oed', null)?.contentLanguage).toBe('en-GB-oed')
  })
})

const contentKey = MCP_CONTENT_LANGUAGE_META_KEY
const preferenceKey = MCP_ACCEPT_LANGUAGE_META_KEY

describe('SEP-2792 response localization', () => {
  function setup(localize?: McpLanguageOptions['localize']) {
    const settings = normalizeLanguageOptions({
      supportedLanguages: ['en', 'fr-CA'],
      defaultLanguage: 'en',
      localize
    })
    const requestLanguage = resolveHttpRequestLanguage(
      settings,
      { _meta: { [preferenceKey]: 'fr-ca, en;q=0.5' } },
      new Headers({ 'Accept-Language': 'fr-ca, en;q=0.5' })
    )
    return { settings, requestLanguage }
  }

  test('uses canonical request metadata and ignores inherited fields', () => {
    const { settings, requestLanguage } = setup()
    expect(requestLanguage?.contentLanguage).toBe('fr-CA')
    const headers = new Headers({ 'Accept-Language': 'fr-ca, en;q=0.5' })
    const params = { _meta: Object.create({ [preferenceKey]: 'fr-ca, en;q=0.5' }) }
    expect(resolveHttpRequestLanguage(settings, params, headers)).toBeUndefined()
  })

  test.each([
    ['tools/list', 'tools', 'tool'],
    ['resources/list', 'resources', 'resource'],
    ['resources/templates/list', 'resourceTemplates', 'resourceTemplate'],
    ['prompts/list', 'prompts', 'prompt']
  ] as const)('localizes contextual metadata for %s', (method, key, kind) => {
    const observed: McpLanguageDisplayContext[] = []
    const { settings, requestLanguage } = setup((context) => {
      observed.push(context)
      return 'Libellé'
    })
    const item = Object.freeze({
      name: 'item-id',
      title: 'Label',
      description: 'Help',
      uri: 'example://name',
      uriTemplate: 'example://{name}',
      mimeType: 'text/plain',
      inputSchema: { properties: { title: { title: 'Unchanged schema label' } } }
    })
    const input = { [key]: [item], _meta: { keep: true }, nextCursor: 'opaque' }
    const output = localizeLanguageResult(method, input, requestLanguage, settings)
    expect(output).toEqual({
      [key]: [{ ...item, title: 'Libellé', description: 'Libellé' }],
      _meta: { keep: true, [contentKey]: 'fr-CA' },
      nextCursor: 'opaque'
    })
    expect(observed).toEqual([
      {
        field: `${kind}.title` as const,
        method,
        language: 'fr-CA',
        path: [key, '0', 'title'],
        id: 'item-id',
        original: 'Label'
      },
      {
        field: `${kind}.description` as const,
        method,
        language: 'fr-CA',
        path: [key, '0', 'description'],
        id: 'item-id',
        original: 'Help'
      }
    ])
    expect(item.title).toBe('Label')
  })

  test('localizes tool annotation title and nested prompt argument strings', () => {
    const { settings, requestLanguage } = setup(({ field }) => field)
    const tools = {
      tools: [{ name: 'tool-id', annotations: { title: 'Action', destructiveHint: true } }]
    }
    const prompts = {
      prompts: [
        {
          name: 'prompt-id',
          arguments: [{ name: 'arg-id', title: 'Value', description: 'Help', required: true }]
        }
      ]
    }
    expect(localizeLanguageResult('tools/list', tools, requestLanguage, settings)).toEqual({
      tools: [
        { name: 'tool-id', annotations: { title: 'toolAnnotation.title', destructiveHint: true } }
      ],
      _meta: { [contentKey]: 'fr-CA' }
    })
    expect(localizeLanguageResult('prompts/list', prompts, requestLanguage, settings)).toEqual({
      prompts: [
        {
          name: 'prompt-id',
          arguments: [
            {
              name: 'arg-id',
              title: 'promptArgument.title',
              description: 'promptArgument.description',
              required: true
            }
          ]
        }
      ],
      _meta: { [contentKey]: 'fr-CA' }
    })
  })

  test('localizes Implementation metadata and reports mixed fallback', () => {
    const { settings, requestLanguage } = setup(({ field }) =>
      field === 'implementation.title' ? 'Serveur' : undefined
    )
    const info = {
      name: 'server-id',
      title: 'Server',
      description: 'Original description',
      version: 'v1'
    }
    const modern = {
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
      instructions: 'Keep instructions'
    }
    expect(localizeLanguageResult('server/discover', modern, requestLanguage, settings)).toEqual({
      ...modern,
      _meta: {
        'io.modelcontextprotocol/serverInfo': { ...info, title: 'Serveur' },
        [contentKey]: 'fr-CA, en'
      }
    })
    expect(
      localizeLanguageResult('initialize', { serverInfo: info }, requestLanguage, settings)
    ).toEqual({ serverInfo: { ...info, title: 'Serveur' }, _meta: { [contentKey]: 'fr-CA, en' } })
    expect(localizeLanguageResult('initialize', { serverInfo: info }, undefined, settings)).toEqual(
      { serverInfo: info }
    )
    expect(info.title).toBe('Server')
  })

  test('localizes form properties and URL messages but leaves handler content and schema identifiers intact', () => {
    const { settings, requestLanguage } = setup(({ field, original }) => field + ':' + original)
    const details = {
      type: 'object',
      properties: {
        email: { type: 'string', title: 'Email', description: 'Address', const: 'token' },
        status: {
          type: 'array',
          items: { properties: { verified: { title: 'Verified', enum: ['yes', 'no'] } } }
        }
      },
      required: ['email'],
      title: 'Whole schema',
      examples: [{ title: 'Example' }]
    }
    const result = {
      resultType: 'input_required',
      requestState: 'opaque',
      inputRequests: {
        form: {
          method: 'elicitation/create',
          params: { message: 'Enter', requestedSchema: details }
        },
        link: {
          method: 'elicitation/create',
          params: {
            mode: 'url',
            message: 'Open',
            url: 'https://example.com/',
            elicitationId: 'opaque'
          }
        },
        sample: { method: 'sampling/createMessage', params: { message: 'Do not translate' } }
      }
    }
    const before = structuredClone(result)
    const output = localizeLanguageResult('tools/call', result, requestLanguage, settings)
    expect(output).toEqual({
      ...result,
      _meta: { [contentKey]: 'fr-CA' },
      inputRequests: {
        form: {
          method: 'elicitation/create',
          params: {
            message: 'elicitation.message:Enter',
            requestedSchema: {
              ...details,
              properties: {
                email: {
                  ...details.properties.email,
                  title: 'elicitation.property.title:Email',
                  description: 'elicitation.property.description:Address'
                },
                status: {
                  ...details.properties.status,
                  items: {
                    properties: {
                      verified: {
                        title: 'elicitation.property.title:Verified',
                        enum: ['yes', 'no']
                      }
                    }
                  }
                }
              }
            }
          }
        },
        link: {
          ...result.inputRequests.link,
          params: { ...result.inputRequests.link.params, message: 'elicitation.message:Open' }
        },
        sample: result.inputRequests.sample
      }
    })
    expect(result).toEqual(before)
    const arbitrary = {
      content: [{ type: 'text', text: 'Handler output' }],
      message: 'Error detail'
    }
    expect(localizeLanguageResult('tools/call', arbitrary, requestLanguage, settings)).toBe(
      arbitrary
    )
  })

  test('bounds schema work and preserves special property keys', () => {
    let titleCalls = 0
    const { settings, requestLanguage } = setup(({ field }) => {
      if (field === 'elicitation.property.title') titleCalls++
      return 'Libellé'
    })
    const properties = Object.fromEntries(
      ['__proto__', ...Array.from({ length: 600 }, (_, index) => 'field' + index)].map((key) => [
        key,
        { title: 'Label' }
      ])
    )
    const result = {
      resultType: 'input_required',
      inputRequests: {
        form: {
          method: 'elicitation/create',
          params: {
            message: 'Enter',
            requestedSchema: { type: 'object', properties }
          }
        }
      }
    }
    const output = localizeLanguageResult('tools/call', result, requestLanguage, settings)
    expect(output).toMatchObject({
      inputRequests: {
        form: {
          params: {
            requestedSchema: {
              properties: {
                ['__proto__']: { title: 'Libellé' },
                field599: { title: 'Label' }
              }
            }
          }
        }
      }
    })
    expect(Object.hasOwn(properties, '__proto__')).toBe(true)
    expect(titleCalls).toBe(511)
  })

  test('localizes only progress text and preserves defaults when callbacks fail', () => {
    const params = {
      progressToken: 'opaque',
      progress: 1,
      total: 2,
      message: 'Loading',
      _meta: { keep: 'field' }
    }
    const { settings, requestLanguage } = setup(({ field }) => field)
    expect(localizeLanguageProgress(params, requestLanguage, settings)).toEqual({
      ...params,
      message: 'progress.message',
      _meta: { keep: 'field', [contentKey]: 'fr-CA' }
    })
    const failure = setup(() => {
      throw new Error('host error')
    })
    expect(localizeLanguageProgress(params, failure.requestLanguage, failure.settings)).toEqual({
      ...params,
      _meta: { keep: 'field', [contentKey]: 'en' }
    })
    const noMessage = { progressToken: 0, progress: 1 }
    expect(localizeLanguageProgress(noMessage, requestLanguage, settings)).toBe(noMessage)
  })

  test('accepts only safe HTTP content language fields from metadata', () => {
    for (const invalid of [' fr ', 'fr\n', 'fr;v=1', 'fr, en,', 'fr, 🌍']) {
      expect(contentLanguageOf({ _meta: { [contentKey]: invalid } })).toBeUndefined()
    }
    expect(contentLanguageOf({ _meta: { [contentKey]: 'fr-CA, en' } })).toBe('fr-CA, en')
  })

  test('mirrors canonical output and varies on opt-in even when a request omits its preference', () => {
    const { settings, requestLanguage } = setup(({ original }) => original)
    const headers = new Headers({ Vary: 'Origin, ACCEPT-LANGUAGE' })
    const result = {
      tools: [{ name: 'item-id', title: 'Label' }],
      cacheScope: 'public',
      ttlMs: 5000
    }
    const localized = localizeLanguageResult('tools/list', result, requestLanguage, settings)
    applyLanguageResponseHeaders(headers, true, requestLanguage, contentLanguageOf(localized))
    expect(headers.get('Content-Language')).toBe('fr-CA')
    expect(headers.get('Cache-Control')).toBeNull()
    expect(headers.get('Vary')).toBe('Origin, ACCEPT-LANGUAGE')
    expect(localized.cacheScope).toBe('public')

    const omitted = new Headers({ Vary: 'Origin' })
    applyLanguageResponseHeaders(omitted, true, undefined)
    expect(omitted.get('Vary')).toBe('Origin, Accept-Language')
    expect(omitted.get('Content-Language')).toBeNull()

    const disabled = new Headers()
    applyLanguageResponseHeaders(disabled, false, undefined)
    expect(disabled.get('Vary')).toBeNull()
  })

  test('keeps shared caches out when the HTTP preference mirror is stripped', () => {
    const { settings } = setup(({ original }) => original)
    const requestLanguage = resolveHttpRequestLanguage(
      settings,
      { _meta: { [preferenceKey]: 'fr-CA' } },
      new Headers()
    )
    const result = {
      tools: [{ name: 'item-id', title: 'Label' }],
      cacheScope: 'public',
      ttlMs: 5000
    }
    const localized = localizeLanguageResult('tools/list', result, requestLanguage, settings)
    expect(localized.cacheScope).toBe('private')
    expect(localized.ttlMs).toBe(5000)
    const streamHeaders = new Headers({ Vary: '*' })
    applyLanguageResponseHeaders(streamHeaders, true, requestLanguage)
    expect(streamHeaders.get('Vary')).toBe('*')
    expect(streamHeaders.get('Cache-Control')).toBe('private')
    expect(streamHeaders.get('Content-Language')).toBeNull()
  })
})
