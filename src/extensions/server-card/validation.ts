import { isRecord } from '../../internal.js'
import { validateJsonSchema } from '../../schema/validate.js'
import serverCardSchema from './schema.json' with { type: 'json' }
import { MCP_SERVER_CARD_REVISION, type McpServerCard, type McpServerCardOptions } from './types.js'

const RANGE = /^(?:\^|~|>=?|<=?|=)|(?:^|\.)[xX*](?:\.|$)|\s+-\s+/u
const SERVER_CARD_SCHEMA = Object.freeze({ ...serverCardSchema, $ref: '#/$defs/ServerCard' })

export function normalizeServerCardOptions(
  options: McpServerCardOptions
): Required<McpServerCardOptions> {
  if (
    options.version !== undefined &&
    options.version !== 'current' &&
    options.version !== MCP_SERVER_CARD_REVISION
  ) {
    throw new TypeError(`Unsupported server-card revision: ${options.version}`)
  }
  assertServerCard(options.card, options.environment ?? 'production')
  const maxAgeSeconds = options.maxAgeSeconds ?? 3600
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new TypeError('Server-card maxAgeSeconds must be a non-negative integer')
  }
  return {
    version: MCP_SERVER_CARD_REVISION,
    card: structuredClone(options.card),
    maxAgeSeconds,
    environment: options.environment ?? 'production'
  }
}

export function assertServerCard(
  card: unknown,
  environment: 'production' | 'development'
): asserts card is McpServerCard {
  if (!isRecord(card)) throw new TypeError('Server card must be an object')
  assertServerCardSchema(card)
  const validated = card as unknown as McpServerCard
  assertAllowedServerCardFields(card)
  assertString(validated.version, 'version', 0, 255)
  if (RANGE.test(validated.version))
    throw new TypeError('Server card version must be an exact string, not a range')
  assertServerCardUris(validated, environment)
  assertNoEmbeddedSecret(validated)
}

function assertServerCardSchema(card: Record<string, unknown>): void {
  const result = validateJsonSchema(SERVER_CARD_SCHEMA, card)
  if (result.ok) return
  const issue = result.issues?.[0]
  const detail = issue ? ` at ${issue.path}: ${issue.message}` : ''
  throw new TypeError(`Server card does not match the pinned schema${detail}`)
}

function assertAllowedServerCardFields(card: Record<string, unknown>): void {
  const allowed = new Set([
    '$schema',
    '_meta',
    'description',
    'icons',
    'name',
    'remotes',
    'repository',
    'title',
    'version',
    'websiteUrl'
  ])
  const unexpected = Object.keys(card).find((key) => !allowed.has(key))
  if (unexpected) throw new TypeError(`Server card must not expose ${unexpected}`)
}

function assertServerCardUris(
  card: McpServerCard,
  environment: 'production' | 'development'
): void {
  if (card.websiteUrl !== undefined)
    assertSafeAncillaryUri(card.websiteUrl, environment, 'websiteUrl')
  for (const [index, icon] of (card.icons ?? []).entries()) {
    assertSafeAncillaryUri(icon.src, environment, `icons[${index}].src`, true)
  }
  assertRepository(card, environment)
  for (const remote of card.remotes ?? []) assertSafeRemote(remote, environment)
}

function assertRepository(card: McpServerCard, environment: 'production' | 'development'): void {
  if (card.repository === undefined) return
  assertSafeAncillaryUri(card.repository.url, environment, 'repository.url')
  if (card.repository.subfolder !== undefined)
    assertCleanRepositorySubfolder(card.repository.subfolder)
}

function assertSafeRemote(
  remote: NonNullable<McpServerCard['remotes']>[number],
  environment: 'production' | 'development'
): void {
  if (remote.url.startsWith('{')) assertSafeRemoteTemplate(remote, environment)
  else assertRemoteUri(remote.url, environment, 'remote.url')
}

function assertSafeRemoteTemplate(
  remote: NonNullable<McpServerCard['remotes']>[number],
  environment: 'production' | 'development'
): void {
  const names = [...remote.url.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/gu)].map(
    (match) => match[1] as string
  )
  for (const name of names) {
    for (const candidate of templateCandidates(remote.variables?.[name])) {
      assertTemplateCandidate(remote, names, name, candidate, environment)
    }
  }
}

function templateCandidates(input: unknown): string[] {
  if (!isRecord(input)) return []
  return [
    input.value,
    input.default,
    ...(Array.isArray(input.choices) ? input.choices : [])
  ].filter((candidate): candidate is string => typeof candidate === 'string')
}

function assertTemplateCandidate(
  remote: NonNullable<McpServerCard['remotes']>[number],
  names: readonly string[],
  name: string,
  candidate: string,
  environment: 'production' | 'development'
): void {
  let rendered = remote.url
  for (const variable of names) {
    const selected =
      variable === name ? candidate : preferredTemplateValue(remote.variables?.[variable])
    rendered = rendered.replaceAll(`{${variable}}`, selected)
  }
  const target = /^https?:\/\//u.test(rendered) ? rendered : candidate
  if (/^https?:\/\//u.test(target)) assertRemoteUri(target, environment, `remote.variables.${name}`)
}

function assertCleanRepositorySubfolder(value: string): void {
  const decoded = repeatedlyDecode(value)
  const segments = decoded.split('/')
  if (unsafeRepositoryPath(value, decoded, segments)) {
    throw new TypeError('Server card repository.subfolder must be a clean relative path')
  }
}

function repeatedlyDecode(value: string): string {
  let decoded = value
  try {
    for (let depth = 0; depth < 4; depth++) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    }
  } catch {
    throw new TypeError('Server card repository.subfolder must be a clean relative path')
  }
  return decoded
}

function unsafeRepositoryPath(
  value: string,
  decoded: string,
  segments: readonly string[]
): boolean {
  return (
    value.length === 0 ||
    decoded.startsWith('/') ||
    decoded.includes('\\') ||
    /%(?:2e|2f|5c)/iu.test(decoded) ||
    /[?#]/u.test(decoded) ||
    /^[a-zA-Z]:/u.test(decoded) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  )
}

function preferredTemplateValue(input: unknown): string {
  if (!isRecord(input)) return 'example'
  if (typeof input.value === 'string') return input.value
  if (typeof input.default === 'string') return input.default
  if (Array.isArray(input.choices) && typeof input.choices[0] === 'string') return input.choices[0]
  return 'example'
}

function assertNoEmbeddedSecret(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoEmbeddedSecret)
    return
  }
  if (!isRecord(value)) return
  assertSecretObject(value)
  for (const [key, nested] of Object.entries(value)) {
    assertSecretEntry(key, nested)
    assertNoEmbeddedSecret(nested)
  }
}

function assertSecretObject(value: Record<string, unknown>): void {
  const actualValue = hasEmbeddedValue(value)
  if (value.isSecret === true && actualValue) {
    throw new TypeError('Server cards must not embed secret values, defaults, or choices')
  }
  const sensitiveName = typeof value.name === 'string' && SENSITIVE_NAME.test(value.name)
  if (sensitiveName && actualValue)
    throw new TypeError('Server cards must not embed credentials or tokens')
}

const SENSITIVE_NAME = /(?:authorization|cookie|token|password|secret|credential|api[-_]?key)/iu
const SENSITIVE_KEY =
  /(?:^|[./_-])(?:authorization|token|password|secret|credential|api[-_]?key)(?:$|[./_-])/iu

function hasEmbeddedValue(value: Record<string, unknown>): boolean {
  if (typeof value.value === 'string' || typeof value.default === 'string') return true
  return Array.isArray(value.choices) && value.choices.length > 0
}

function assertSecretEntry(key: string, nested: unknown): void {
  if (key === 'isSecret' || !SENSITIVE_KEY.test(key)) return
  const nestedValue =
    isRecord(nested) && (typeof nested.value === 'string' || typeof nested.default === 'string')
  if (typeof nested === 'string' || nestedValue) {
    throw new TypeError('Server cards must not embed credentials or tokens')
  }
}

function assertRemoteUri(
  value: unknown,
  environment: 'production' | 'development',
  label: string
): void {
  assertString(value, label)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`Server card ${label} must be an absolute URI`)
  }
  assertNoCredentials(url, label)
  assertRemoteTopology(url, environment, label)
  assertRemoteProtocol(url, environment, label)
}

function assertRemoteTopology(
  url: URL,
  environment: 'production' | 'development',
  label: string
): void {
  const developmentLoopback = environment === 'development' && isLoopbackHost(url.hostname)
  if (isPrivateHost(url.hostname) && !developmentLoopback) {
    throw new TypeError(`Server card ${label} must not expose private topology`)
  }
}

function assertRemoteProtocol(
  url: URL,
  environment: 'production' | 'development',
  label: string
): void {
  if (environment === 'production' && url.protocol !== 'https:') {
    throw new TypeError(`Server card ${label} must use HTTPS in production`)
  }
  if (environment === 'development' && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new TypeError(`Server card ${label} HTTP is limited to loopback development`)
  }
}

function assertSafeAncillaryUri(
  value: unknown,
  environment: 'production' | 'development',
  label: string,
  allowData = false
): void {
  assertString(value, label)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`Server card ${label} must be an absolute URI`)
  }
  if (allowData && url.protocol === 'data:') return
  assertNoCredentials(url, label)
  if (
    isPrivateHost(url.hostname) &&
    !(environment === 'development' && isLoopbackHost(url.hostname))
  ) {
    throw new TypeError(`Server card ${label} must not expose private topology`)
  }
}

function assertNoCredentials(url: URL, label: string): void {
  if (url.username || url.password) {
    throw new TypeError(`Server card ${label} must not embed credentials`)
  }
}

function normalizedHost(host: string): string {
  return host.replace(/^\[|\]$/gu, '').toLowerCase()
}

function isLoopbackHost(host: string): boolean {
  const value = normalizedHost(host)
  return (
    value === 'localhost' ||
    value.endsWith('.localhost') ||
    value === '::1' ||
    /^127\./u.test(value) ||
    mappedIpv4(value)?.[0] === 127
  )
}

function isPrivateHost(host: string): boolean {
  const value = normalizedHost(host)
  const mapped = mappedIpv4(value)
  return (
    isLoopbackHost(value) ||
    value === '::' ||
    value === '0.0.0.0' ||
    /\.(?:local|internal|home|lan)$/u.test(value) ||
    isPrivateIpv4(value.split('.').map(Number)) ||
    /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f:]*$/u.test(value) ||
    (mapped !== undefined && isPrivateIpv4(mapped))
  )
}

function mappedIpv4(host: string): number[] | undefined {
  if (!host.startsWith('::ffff:')) return undefined
  const suffix = host.slice('::ffff:'.length)
  if (suffix.includes('.')) return suffix.split('.').map(Number)
  const groups = suffix.split(':')
  if (groups.length !== 2) return undefined
  const high = Number.parseInt(groups[0] ?? '', 16)
  const low = Number.parseInt(groups[1] ?? '', 16)
  if (!Number.isInteger(high) || !Number.isInteger(low)) return undefined
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

function isPrivateIpv4(parts: number[]): boolean {
  if (!validIpv4Parts(parts)) return false
  const [first = -1, second = -1] = parts
  if ([0, 10, 127].includes(first) || first >= 224) return true
  return isReservedIpv4Pair(first, second)
}

function validIpv4Parts(parts: readonly number[]): boolean {
  return (
    parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  )
}

function isReservedIpv4Pair(first: number, second: number): boolean {
  if (first === 100) return second >= 64 && second <= 127
  if (first === 169) return second === 254
  if (first === 172) return second >= 16 && second <= 31
  if (first === 192) return second === 168
  return first === 198 && (second === 18 || second === 19)
}

function assertString(
  value: unknown,
  label: string,
  min = 1,
  max = Number.POSITIVE_INFINITY
): asserts value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max)
    throw new TypeError(`Server card ${label} is invalid`)
}
