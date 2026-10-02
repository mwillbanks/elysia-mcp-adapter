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
  const schemaResult = validateJsonSchema(SERVER_CARD_SCHEMA, card)
  if (!schemaResult.ok) {
    const issue = schemaResult.issues?.[0]
    throw new TypeError(
      `Server card does not match the pinned schema${issue ? ` at ${issue.path}: ${issue.message}` : ''}`
    )
  }
  const validated = card as unknown as McpServerCard
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
  for (const key of Object.keys(card)) {
    if (!allowed.has(key)) throw new TypeError(`Server card must not expose ${key}`)
  }
  assertString(validated.version, 'version', 0, 255)
  if (RANGE.test(validated.version))
    throw new TypeError('Server card version must be an exact string, not a range')
  if (validated.websiteUrl !== undefined)
    assertSafeAncillaryUri(validated.websiteUrl, environment, 'websiteUrl')
  for (const [index, icon] of (validated.icons ?? []).entries()) {
    assertSafeAncillaryUri(icon.src, environment, `icons[${index}].src`, true)
  }
  if (validated.repository !== undefined) {
    assertSafeAncillaryUri(validated.repository.url, environment, 'repository.url')
    if (validated.repository.subfolder !== undefined) {
      assertCleanRepositorySubfolder(validated.repository.subfolder)
    }
  }
  if (validated.remotes !== undefined) {
    for (const remote of validated.remotes) {
      if (remote.url.startsWith('{')) assertSafeRemoteTemplate(remote, environment)
      else assertRemoteUri(remote.url, environment, 'remote.url')
    }
  }
  assertNoEmbeddedSecret(validated)
}

function assertSafeRemoteTemplate(
  remote: NonNullable<McpServerCard['remotes']>[number],
  environment: 'production' | 'development'
): void {
  const names = [...remote.url.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/gu)].map(
    (match) => match[1] as string
  )
  for (const name of names) {
    const input = remote.variables?.[name]
    if (!isRecord(input)) continue
    const candidates = [
      input.value,
      input.default,
      ...(Array.isArray(input.choices) ? input.choices : [])
    ].filter((candidate): candidate is string => typeof candidate === 'string')
    for (const candidate of candidates) {
      let rendered = remote.url
      for (const variable of names) {
        const selected =
          variable === name ? candidate : preferredTemplateValue(remote.variables?.[variable])
        rendered = rendered.replaceAll(`{${variable}}`, selected)
      }
      if (/^https?:\/\//u.test(rendered)) {
        assertRemoteUri(rendered, environment, `remote.variables.${name}`)
      } else if (/^https?:\/\//u.test(candidate)) {
        assertRemoteUri(candidate, environment, `remote.variables.${name}`)
      }
    }
  }
}

function assertCleanRepositorySubfolder(value: string): void {
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
  const segments = decoded.split('/')
  if (
    value.length === 0 ||
    decoded.startsWith('/') ||
    decoded.includes('\\') ||
    /%(?:2e|2f|5c)/iu.test(decoded) ||
    /[?#]/u.test(decoded) ||
    /^[a-zA-Z]:/u.test(decoded) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError('Server card repository.subfolder must be a clean relative path')
  }
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
  const actualValue =
    typeof value.value === 'string' ||
    typeof value.default === 'string' ||
    (Array.isArray(value.choices) && value.choices.length > 0)
  if (value.isSecret === true && actualValue) {
    throw new TypeError('Server cards must not embed secret values, defaults, or choices')
  }
  if (
    typeof value.name === 'string' &&
    /(?:authorization|cookie|token|password|secret|credential|api[-_]?key)/iu.test(value.name) &&
    actualValue
  ) {
    throw new TypeError('Server cards must not embed credentials or tokens')
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      key !== 'isSecret' &&
      /(?:^|[./_-])(?:authorization|token|password|secret|credential|api[-_]?key)(?:$|[./_-])/iu.test(
        key
      ) &&
      (typeof nested === 'string' ||
        (isRecord(nested) &&
          (typeof nested.value === 'string' || typeof nested.default === 'string')))
    ) {
      throw new TypeError('Server cards must not embed credentials or tokens')
    }
    assertNoEmbeddedSecret(nested)
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
  const loopback = isLoopbackHost(url.hostname)
  if (isPrivateHost(url.hostname) && !(environment === 'development' && loopback))
    throw new TypeError(`Server card ${label} must not expose private topology`)
  if (environment === 'production' && url.protocol !== 'https:')
    throw new TypeError(`Server card ${label} must use HTTPS in production`)
  if (environment === 'development' && url.protocol === 'http:' && !loopback)
    throw new TypeError(`Server card ${label} HTTP is limited to loopback development`)
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
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  const [first = -1, second = -1] = parts
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  )
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
