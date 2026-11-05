import { isRecord } from '../internal.js'
import { McpProtocolError } from './protocol-error.js'

export const MCP_ACCEPT_LANGUAGE_META_KEY = 'io.modelcontextprotocol/acceptLanguage'
export const MCP_CONTENT_LANGUAGE_META_KEY = 'io.modelcontextprotocol/contentLanguage'

const MAX_PREFERENCE_LENGTH = 4096
const MAX_LANGUAGE_RANGES = 100
const MAX_TAG_LENGTH = 255
const WEIGHTED_RANGE =
  /^(\*|[a-z]{1,8}(?:-[a-z0-9]{1,8})*)(?:[ \t]*;[ \t]*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$/iu

// RFC 5646 langtag, private-use and grandfathered forms. Keep the host's spelling
// for display catalogs and the Content-Language field.
const LANGUAGE_TAG =
  /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?<variants>(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*)(?<extensions>(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*)?(?:-x(?:-[a-z0-9]{1,8})+)?$/iu
const PRIVATE_USE_TAG = /^x(?:-[a-z0-9]{1,8})+$/iu
const GRANDFATHERED_TAGS = new Set([
  'art-lojban',
  'cel-gaulish',
  'en-gb-oed',
  'i-ami',
  'i-bnn',
  'i-default',
  'i-enochian',
  'i-hak',
  'i-klingon',
  'i-lux',
  'i-mingo',
  'i-navajo',
  'i-pwn',
  'i-tao',
  'i-tay',
  'i-tsu',
  'no-bok',
  'no-nyn',
  'sgn-be-fr',
  'sgn-be-nl',
  'sgn-ch-de',
  'zh-guoyu',
  'zh-hakka',
  'zh-min',
  'zh-min-nan',
  'zh-xiang'
])

type DisplayMetadata =
  'implementation' | 'tool' | 'resource' | 'resourceTemplate' | 'prompt' | 'promptArgument'

export type McpLanguageDisplayField =
  | `${DisplayMetadata}.${'title' | 'description'}`
  | 'toolAnnotation.title'
  | 'elicitation.message'
  | 'elicitation.property.title'
  | 'elicitation.property.description'
  | 'progress.message'

export interface McpLanguageDisplayContext {
  readonly language: string
  readonly method: string
  readonly field: McpLanguageDisplayField
  readonly path: readonly string[]
  readonly original: string
  /** Stable item or input request identifier, when present. */
  readonly id?: string
}

export interface McpLanguageOptions {
  readonly supportedLanguages: readonly string[]
  readonly defaultLanguage: string
  /** Resolve a host-provided display string, or return undefined to keep the original. */
  readonly localize?: (context: McpLanguageDisplayContext) => string | undefined
}

export interface NormalizedMcpLanguageOptions {
  readonly supportedLanguages: ReadonlyMap<string, string>
  readonly defaultLanguage: string
  readonly localize?: McpLanguageOptions['localize']
}

export interface McpRequestLanguage {
  /** The original canonical preference, including spelling and ordering, for cache partitioning. */
  readonly acceptLanguage: string
  readonly contentLanguage: string
  /** False when the preference is only visible inside the RPC payload. */
  readonly mirrored: boolean
}

interface LanguageRange {
  range: string
  quality: number
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function hasUniqueTagParts(groups: Record<string, string>): boolean {
  const variants = (groups.variants ?? '').split('-').filter(Boolean)
  const singletons = (groups.extensions ?? '').match(/-[a-z0-9](?=-)/gu) ?? []
  return !hasDuplicates(variants) && !hasDuplicates(singletons)
}

function isLanguageTag(lower: string): boolean {
  if (GRANDFATHERED_TAGS.has(lower) || PRIVATE_USE_TAG.test(lower)) return true
  const groups = LANGUAGE_TAG.exec(lower)?.groups
  return groups !== undefined && hasUniqueTagParts(groups)
}

function normalizeLanguageTag(tag: unknown): string {
  if (typeof tag === 'string' && tag.length <= MAX_TAG_LENGTH && !/[^A-Za-z0-9-]/u.test(tag)) {
    const lower = tag.toLowerCase()
    if (isLanguageTag(lower)) return lower
  }
  throw new TypeError('MCP languages must be well-formed BCP 47 tags')
}

export function normalizeLanguageOptions(
  options: McpLanguageOptions | undefined
): NormalizedMcpLanguageOptions | undefined {
  if (options === undefined) return undefined
  if (!Array.isArray(options?.supportedLanguages) || options.supportedLanguages.length === 0) {
    throw new TypeError('MCP language negotiation requires at least one supported language')
  }
  const supportedLanguages = new Map<string, string>()
  for (const tag of options.supportedLanguages) {
    const key = normalizeLanguageTag(tag)
    if (supportedLanguages.has(key)) throw new TypeError('MCP supported languages must be unique')
    supportedLanguages.set(key, tag)
  }
  const defaultLanguage = supportedLanguages.get(normalizeLanguageTag(options.defaultLanguage))
  if (defaultLanguage === undefined)
    throw new TypeError('The MCP default language must be supported')
  if (options.localize !== undefined && typeof options.localize !== 'function') {
    throw new TypeError('MCP display localization must be a function')
  }
  return { supportedLanguages, defaultLanguage, localize: options.localize }
}

function splitLanguageField(value: string): string[] {
  if (value.length > MAX_PREFERENCE_LENGTH || /[^\x20-\x7e\t]/u.test(value)) return []
  const entries = value.split(',')
  return entries.length <= MAX_LANGUAGE_RANGES ? entries : []
}

export function isContentLanguageField(value: string): boolean {
  if (value.trim() !== value) return false
  const fields = splitLanguageField(value)
  return (
    fields.length > 0 &&
    fields.every((field) => {
      const tag = field.trim()
      return tag.length <= MAX_TAG_LENGTH && isLanguageTag(tag.toLowerCase())
    })
  )
}

function parseLanguageRanges(value: string): LanguageRange[] | undefined {
  const ranges = new Map<string, number>()
  for (const entry of splitLanguageField(value)) {
    const field = entry.replace(/^[ \t]+|[ \t]+$/gu, '')
    if (!field) continue
    const match = WEIGHTED_RANGE.exec(field)
    if (!match?.[1]) return undefined
    const range = match[1].toLowerCase()
    // Resolve ambiguous duplicates deterministically using their first occurrence.
    if (!ranges.has(range)) ranges.set(range, Number(match[2] ?? '1'))
  }
  return Array.from(ranges, ([range, quality]) => ({ range, quality }))
}

function explicitlyExcluded(tag: string, ranges: readonly LanguageRange[]): boolean {
  let specificity = -1
  let excluded = false
  for (const { range, quality } of ranges) {
    const match = range === '*' || tag === range || tag.startsWith(range + '-')
    const length = range === '*' ? 0 : range.length
    if (match && length > specificity) {
      specificity = length
      excluded = quality === 0
    }
  }
  return excluded
}

function lookupLanguage(options: NormalizedMcpLanguageOptions, ranges: LanguageRange[]): string {
  // RFC 4647 lookup considers specific ranges in preference order and uses the
  // configured default when only the wildcard remains or no tag matches.
  const ranked = ranges.filter(({ range, quality }) => range !== '*' && quality > 0)
  ranked.sort((a, b) => b.quality - a.quality)
  for (const { range } of ranked) {
    const subtags = range.split('-')
    while (subtags.length > 0) {
      const candidate = subtags.join('-')
      const supported = options.supportedLanguages.get(candidate)
      if (supported !== undefined && !explicitlyExcluded(candidate, ranges)) return supported
      subtags.pop()
      if (subtags.at(-1)?.length === 1) subtags.pop()
    }
  }
  return options.defaultLanguage
}

export function resolveHttpRequestLanguage(
  settings: NormalizedMcpLanguageOptions | undefined,
  params: unknown,
  headers: Headers
): McpRequestLanguage | undefined {
  const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined
  const preference =
    meta && Object.hasOwn(meta, MCP_ACCEPT_LANGUAGE_META_KEY)
      ? meta[MCP_ACCEPT_LANGUAGE_META_KEY]
      : undefined
  return resolveRequestLanguage(settings, preference, headers.get('Accept-Language'))
}

export function resolveRequestLanguage(
  options: NormalizedMcpLanguageOptions | undefined,
  metaValue: unknown,
  acceptLanguageHeader: string | null
): McpRequestLanguage | undefined {
  if (options === undefined || metaValue === undefined) return undefined
  // Headers.get exposes the combined HTTP field value. Do not normalize either
  // carrier before the exact comparison, even when its grammar is malformed.
  if (acceptLanguageHeader !== null && metaValue !== acceptLanguageHeader) {
    throw new McpProtocolError(-32020, 'Accept-Language header must match request _meta', 400)
  }
  if (typeof metaValue !== 'string') return undefined
  const ranges = parseLanguageRanges(metaValue)
  if (!ranges?.length) return undefined
  return {
    acceptLanguage: metaValue,
    contentLanguage: lookupLanguage(options, ranges),
    mirrored: acceptLanguageHeader !== null
  }
}
