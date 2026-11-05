import { isRecord } from '../internal.js'
import type { JsonRpcResponse } from '../types.js'
import {
  isContentLanguageField,
  MCP_CONTENT_LANGUAGE_META_KEY,
  type McpLanguageDisplayContext,
  type McpLanguageDisplayField,
  type McpRequestLanguage,
  type NormalizedMcpLanguageOptions
} from './language.js'

const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo'
const MAX_SCHEMA_DEPTH = 32
const MAX_SCHEMA_NODES = 512

type JsonRecord = Record<string, unknown>
type MetadataKind =
  'implementation' | 'tool' | 'resource' | 'resourceTemplate' | 'prompt' | 'promptArgument'
type DisplayLocation = Pick<McpLanguageDisplayContext, 'path' | 'id'>

const LIST_METADATA = new Map<string, readonly [string, MetadataKind]>([
  ['tools/list', ['tools', 'tool']],
  ['resources/list', ['resources', 'resource']],
  ['resources/templates/list', ['resourceTemplates', 'resourceTemplate']],
  ['prompts/list', ['prompts', 'prompt']]
])

function withContentLanguage(record: JsonRecord, value: string): JsonRecord {
  const meta = isRecord(record._meta) ? record._meta : {}
  return { ...record, _meta: { ...meta, [MCP_CONTENT_LANGUAGE_META_KEY]: value } }
}

function translate(
  settings: NormalizedMcpLanguageOptions,
  context: McpLanguageDisplayContext
): string | undefined {
  try {
    const localized = settings.localize?.(context)
    return typeof localized === 'string' ? localized : undefined
  } catch {
    return undefined
  }
}

function createLocalizer(
  method: string,
  language: McpRequestLanguage,
  settings: NormalizedMcpLanguageOptions
) {
  const selected = language.contentLanguage
  const fallback = settings.defaultLanguage
  let usedSelected = false
  let usedFallback = false
  return {
    text(field: McpLanguageDisplayField, location: DisplayLocation, original: unknown): unknown {
      if (typeof original !== 'string') return original
      const localized = translate(settings, {
        language: selected,
        method,
        field,
        ...location,
        original
      })
      if (localized === undefined) usedFallback = true
      else usedSelected = true
      return localized ?? original
    },
    finish(record: JsonRecord): JsonRecord {
      if (!usedSelected && !usedFallback) return record
      if (!usedSelected) return withContentLanguage(record, fallback)
      const mixed = usedFallback && selected !== fallback
      return withContentLanguage(record, mixed ? selected + ', ' + fallback : selected)
    }
  }
}

type Localizer = ReturnType<typeof createLocalizer>

function at(location: DisplayLocation, ...parts: string[]): DisplayLocation {
  return { path: [...location.path, ...parts], id: location.id }
}

function namedLocation(location: DisplayLocation, name: unknown): DisplayLocation {
  return { path: location.path, id: typeof name === 'string' ? name : location.id }
}

function mapRecordProperty(
  record: JsonRecord,
  key: string,
  project: (value: JsonRecord) => JsonRecord
): JsonRecord {
  const value = record[key]
  return isRecord(value) ? { ...record, [key]: project(value) } : record
}

function mapArrayProperty(
  record: JsonRecord,
  key: string,
  project: (value: JsonRecord, index: number) => JsonRecord
): JsonRecord {
  const values = record[key]
  if (!Array.isArray(values)) return record
  return {
    ...record,
    [key]: values.map((value: unknown, index) => (isRecord(value) ? project(value, index) : value))
  }
}

function localizeField(
  record: JsonRecord,
  key: string,
  field: McpLanguageDisplayField,
  location: DisplayLocation,
  localizer: Localizer
): JsonRecord {
  if (!Object.hasOwn(record, key)) return record
  const localized = localizer.text(field, at(location, key), record[key])
  return localized === record[key] ? record : { ...record, [key]: localized }
}

function localizeMetadata(
  record: JsonRecord,
  kind: MetadataKind,
  location: DisplayLocation,
  localizer: Localizer
): JsonRecord {
  const named = namedLocation(location, record.name)
  let localized = record
  for (const field of ['title', 'description'] as const) {
    localized = localizeField(localized, field, `${kind}.${field}`, named, localizer)
  }
  if (kind === 'tool') {
    return mapRecordProperty(localized, 'annotations', (annotations) =>
      localizeField(
        annotations,
        'title',
        'toolAnnotation.title',
        at(named, 'annotations'),
        localizer
      )
    )
  }
  if (kind === 'prompt') {
    return mapArrayProperty(localized, 'arguments', (argument, index) =>
      localizeMetadata(argument, 'promptArgument', at(named, 'arguments', String(index)), localizer)
    )
  }
  return localized
}

function localizeServerInfo(method: string, result: JsonRecord, localizer: Localizer): JsonRecord {
  if (method === 'initialize') {
    return mapRecordProperty(result, 'serverInfo', (info) =>
      localizeMetadata(info, 'implementation', { path: ['serverInfo'] }, localizer)
    )
  }
  return mapRecordProperty(result, '_meta', (meta) =>
    mapRecordProperty(meta, SERVER_INFO_META_KEY, (info) =>
      localizeMetadata(info, 'implementation', { path: ['_meta', SERVER_INFO_META_KEY] }, localizer)
    )
  )
}

interface SchemaTraversal {
  remaining: number
  localizer: Localizer
}

function mapRecordEntries(
  record: JsonRecord,
  project: (value: JsonRecord, key: string) => JsonRecord
): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      isRecord(value) ? project(value, key) : value
    ])
  )
}

function localizeSchemaProperties(
  schema: JsonRecord,
  location: DisplayLocation,
  traversal: SchemaTraversal,
  depth: number
): JsonRecord {
  if (depth + 1 >= MAX_SCHEMA_DEPTH) return schema
  return mapRecordProperty(schema, 'properties', (properties) =>
    mapRecordEntries(properties, (property, key) => {
      if (traversal.remaining <= 0) return property
      const propertyLocation = at(location, 'properties', key)
      const title = localizeField(
        property,
        'title',
        'elicitation.property.title',
        propertyLocation,
        traversal.localizer
      )
      const description = localizeField(
        title,
        'description',
        'elicitation.property.description',
        propertyLocation,
        traversal.localizer
      )
      return localizeSchema(description, propertyLocation, traversal, depth + 1)
    })
  )
}

function localizeSchema(
  schema: JsonRecord,
  location: DisplayLocation,
  traversal: SchemaTraversal,
  depth: number
): JsonRecord {
  if (depth >= MAX_SCHEMA_DEPTH || traversal.remaining <= 0) return schema
  traversal.remaining--
  let localized = localizeSchemaProperties(schema, location, traversal, depth)
  localized = mapRecordProperty(localized, 'items', (items) =>
    localizeSchema(items, at(location, 'items'), traversal, depth + 1)
  )
  for (const key of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) {
    localized = mapArrayProperty(localized, key, (item, index) =>
      localizeSchema(item, at(location, key, String(index)), traversal, depth + 1)
    )
  }
  return localized
}

function localizeElicitation(
  params: JsonRecord,
  location: DisplayLocation,
  localizer: Localizer
): JsonRecord {
  const localized = localizeField(params, 'message', 'elicitation.message', location, localizer)
  if (params.mode === 'url') return localized
  return mapRecordProperty(localized, 'requestedSchema', (schema) =>
    localizeSchema(
      schema,
      at(location, 'requestedSchema'),
      { remaining: MAX_SCHEMA_NODES, localizer },
      0
    )
  )
}

function localizeInputRequests(result: JsonRecord, localizer: Localizer): JsonRecord {
  return mapRecordProperty(result, 'inputRequests', (requests) =>
    mapRecordEntries(requests, (request, id) => {
      if (request.method !== 'elicitation/create') return request
      return mapRecordProperty(request, 'params', (params) =>
        localizeElicitation(params, { id, path: ['inputRequests', id, 'params'] }, localizer)
      )
    })
  )
}

function localizeResult(
  method: string,
  result: JsonRecord,
  localizer: Localizer,
  pendingTaskInput: boolean
): JsonRecord {
  if (result.resultType === 'input_required' || pendingTaskInput) {
    return localizeInputRequests(result, localizer)
  }
  const list = LIST_METADATA.get(method)
  if (!list) return result
  const [key, kind] = list
  return mapArrayProperty(result, key, (item, index) =>
    localizeMetadata(item, kind, { path: [key, String(index)] }, localizer)
  )
}

export function localizeLanguageResult(
  method: string,
  result: JsonRecord,
  language: McpRequestLanguage | undefined,
  settings: NormalizedMcpLanguageOptions | undefined,
  pendingTaskInput = false
): JsonRecord {
  if (!language || !settings) return result
  const localizer = createLocalizer(method, language, settings)
  const withServerInfo = localizeServerInfo(method, result, localizer)
  const localized = localizer.finish(
    localizeResult(method, withServerInfo, localizer, pendingTaskInput)
  )
  if (language.mirrored || localized.cacheScope !== 'public') return localized
  return { ...localized, cacheScope: 'private' }
}

export function localizeTaskInputNotification(
  params: JsonRecord,
  language: McpRequestLanguage | undefined,
  settings: NormalizedMcpLanguageOptions | undefined
): JsonRecord {
  if (!language || !settings) return params
  const localizer = createLocalizer('notifications/tasks', language, settings)
  return localizer.finish(localizeInputRequests(params, localizer))
}

export function localizeLanguageProgress(
  params: JsonRecord,
  language: McpRequestLanguage | undefined,
  settings: NormalizedMcpLanguageOptions | undefined
): JsonRecord {
  if (!language || !settings) return params
  const localizer = createLocalizer('notifications/progress', language, settings)
  return localizer.finish(
    localizeField(params, 'message', 'progress.message', { path: [] }, localizer)
  )
}

export function contentLanguageOf(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value._meta)) return undefined
  const language = value._meta[MCP_CONTENT_LANGUAGE_META_KEY]
  return typeof language === 'string' && isContentLanguageField(language) ? language : undefined
}

function responseContentLanguage(response: JsonRpcResponse): string | undefined {
  return contentLanguageOf(response.result) ?? contentLanguageOf(response.error?.data)
}

function agreedContentLanguage(responses: readonly JsonRpcResponse[]): string | undefined {
  let agreed: string | undefined
  for (const response of responses) {
    const language = responseContentLanguage(response)
    if (language === undefined) continue
    if (agreed !== undefined && agreed !== language) return undefined
    agreed = language
  }
  return agreed
}

export function languageResponseHeader(
  response: JsonRpcResponse | JsonRpcResponse[] | undefined,
  enabled: boolean
): Record<string, string> {
  if (!enabled || !response) return {}
  const contentLanguage = Array.isArray(response)
    ? agreedContentLanguage(response)
    : responseContentLanguage(response)
  return contentLanguage === undefined ? {} : { 'content-language': contentLanguage }
}

export function applyLanguageResponseHeaders(
  headers: Headers,
  enabled: boolean,
  language: McpRequestLanguage | undefined,
  contentLanguage?: string
): void {
  if (!enabled) return
  const vary =
    headers
      .get('Vary')
      ?.split(',')
      .map((value) => value.trim().toLowerCase()) ?? []
  if (!vary.includes('*') && !vary.includes('accept-language'))
    headers.append('Vary', 'Accept-Language')
  if (contentLanguage !== undefined) headers.set('Content-Language', contentLanguage)
  if (language?.mirrored === false) headers.append('Cache-Control', 'private')
}
