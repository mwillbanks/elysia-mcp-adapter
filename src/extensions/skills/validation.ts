import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { isRecord } from '../../internal.js'
import { isBinaryMimeType } from '../../schema/media-type.js'
import { isValidUri } from '../../schema/validate.js'
import type {
  ExplicitSkillRegistration,
  McpSkill,
  McpSkillBytes,
  McpSkillDefinition,
  McpSkillDirectoryEntry,
  McpSkillResourceInput,
  McpSkillResourceValue,
  McpSkillSource,
  McpSkillStoredResource
} from './types.js'

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const SKILL_FILE = 'SKILL.md'

export function buildSkillDefinition(registration: ExplicitSkillRegistration): McpSkillDefinition {
  return definitionFromSource(
    {
      uri: registration.uri,
      skill: registration.skill,
      resources: registration.options.resources,
      directories: registration.options.directories,
      listed: registration.options.listed,
      authorization: registration.options.authorization,
      allowBinary: registration.options.allowBinary
    },
    registration.options.readResource,
    registration.options.readDirectory
  )
}

export function snapshotSkillRegistration(
  uri: string,
  skill: ExplicitSkillRegistration['skill'],
  options: ExplicitSkillRegistration['options']
): ExplicitSkillRegistration {
  const resources =
    options.resources === 'dynamic'
      ? ('dynamic' as const)
      : options.resources
        ? Object.fromEntries(
            Object.entries(options.resources).map(([path, value]) => {
              const input = normalizeResourceInput(value)
              return [
                path,
                {
                  content: copyBytes(input.content),
                  mimeType: input.mimeType
                }
              ]
            })
          )
        : undefined
  return {
    uri,
    skill: copyBytes(skill),
    options: {
      ...options,
      resources,
      directories: options.directories ? [...options.directories] : undefined
    }
  }
}

export function createProviderSkillDefinition(source: McpSkillSource): McpSkillDefinition {
  return definitionFromSource(source)
}

export function assertCompatibleSkillDefinitions(
  existing: Iterable<McpSkillDefinition>,
  incoming: McpSkillDefinition
): void {
  for (const skill of existing) {
    if (skill.uri === incoming.uri) {
      throw new TypeError(`Duplicate MCP skill publication: ${incoming.uri}`)
    }
    assertNestedSkillComplete(skill, incoming)
    assertNestedSkillComplete(incoming, skill)
    for (const [uri, resource] of incoming.files) {
      const shared = skill.files.get(uri)
      if (!shared) continue
      if (!sameStoredResource(shared, resource)) {
        throw new TypeError(
          `Nested skill resource ${uri} must use identical bytes and metadata in every manifest`
        )
      }
    }
  }
}

function assertNestedSkillComplete(
  possibleOuter: McpSkillDefinition,
  possibleInner: McpSkillDefinition
): void {
  if (!isNestedSkill(possibleOuter, possibleInner)) return
  if (possibleOuter.entry.resources === 'dynamic' || possibleInner.entry.resources === 'dynamic') {
    throw new TypeError(
      `Nested skill namespaces require static complete resource manifests: ${possibleOuter.uri} and ${possibleInner.uri}`
    )
  }
  assertInnerFilesIncluded(possibleOuter, possibleInner)
  assertOuterFilesIncluded(possibleOuter, possibleInner)
  assertNestedDirectories(possibleOuter, possibleInner)
}

function isNestedSkill(outer: McpSkillDefinition, inner: McpSkillDefinition): boolean {
  return outer.rootUri !== inner.rootUri && inner.rootUri.startsWith(`${outer.rootUri}/`)
}

function assertInnerFilesIncluded(
  outerSkill: McpSkillDefinition,
  innerSkill: McpSkillDefinition
): void {
  for (const [uri, inner] of innerSkill.files) {
    const outer = outerSkill.files.get(uri)
    if (!outer || !sameStoredResource(outer, inner)) {
      throw new TypeError(
        `Enclosing skill ${outerSkill.uri} must include nested resource ${uri} with identical bytes and metadata`
      )
    }
  }
}

function assertOuterFilesIncluded(
  outerSkill: McpSkillDefinition,
  innerSkill: McpSkillDefinition
): void {
  for (const [uri, outer] of outerSkill.files) {
    if (!isWithinSkill(innerSkill.rootUri, uri)) continue
    const inner = innerSkill.files.get(uri)
    if (!inner || !sameStoredResource(outer, inner)) {
      throw new TypeError(
        `Nested skill ${innerSkill.uri} must include enclosing resource ${uri} with identical bytes and metadata`
      )
    }
  }
}

function assertNestedDirectories(
  outerSkill: McpSkillDefinition,
  innerSkill: McpSkillDefinition
): void {
  for (const directory of outerSkill.directories) {
    if (isWithinSkill(innerSkill.rootUri, directory) && !innerSkill.directories.has(directory)) {
      throw new TypeError(
        `Nested skill ${innerSkill.uri} must include enclosing directory ${directory}`
      )
    }
  }
  for (const directory of innerSkill.directories) {
    if (!outerSkill.directories.has(directory)) {
      throw new TypeError(
        `Enclosing skill ${outerSkill.uri} must include nested directory ${directory}`
      )
    }
  }
}

function sameStoredResource(left: McpSkillStoredResource, right: McpSkillStoredResource): boolean {
  return (
    left.mimeType === right.mimeType &&
    left.binary === right.binary &&
    left.bytes.byteLength === right.bytes.byteLength &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  )
}

function definitionFromSource(
  source: McpSkillSource,
  readResource?: McpSkillDefinition['readResource'],
  readDirectory?: McpSkillDefinition['readDirectory']
): McpSkillDefinition {
  const parsed = parseSkillUri(source.uri)
  const skillBytes = toBytes(source.skill)
  const skillText = decodeUtf8(skillBytes, `${source.uri} must be valid UTF-8`)
  const frontmatter = parseFrontmatter(skillText)
  assertFrontmatter(frontmatter)
  if (parsed.name !== frontmatter.name) {
    throw new TypeError(
      `Skill URI parent segment "${parsed.name}" must equal frontmatter name "${frontmatter.name}"`
    )
  }

  const files = new Map<string, McpSkillStoredResource>()
  const directories = new Set<string>([parsed.rootUri])
  files.set(source.uri, storedResource(source.uri, SKILL_FILE, skillBytes, 'text/markdown', false))
  addStaticResources(source, parsed.rootUri, files, directories)
  addDeclaredDirectories(source, parsed.rootUri, files, directories)

  const resources =
    source.resources === 'dynamic'
      ? ('dynamic' as const)
      : Array.from(files.values()).map(({ uri, bytes }) => ({
          uri,
          digest: digest(bytes),
          size: bytes.byteLength
        }))
  const entry: McpSkill = { uri: source.uri, frontmatter, resources }
  return {
    source: 'explicit',
    uri: source.uri,
    rootUri: parsed.rootUri,
    entry,
    files,
    directories,
    listed: source.listed ?? true,
    authorization: source.authorization,
    allowBinary: source.allowBinary ?? false,
    readResource,
    readDirectory
  }
}

function addStaticResources(
  source: McpSkillSource,
  rootUri: string,
  files: Map<string, McpSkillStoredResource>,
  directories: Set<string>
): void {
  if (source.resources === 'dynamic') return
  for (const [relativePath, value] of Object.entries(source.resources ?? {})) {
    addStaticResource(source, rootUri, relativePath, value, files, directories)
  }
}

function addStaticResource(
  source: McpSkillSource,
  rootUri: string,
  relativePath: string,
  value: McpSkillResourceValue,
  files: Map<string, McpSkillStoredResource>,
  directories: Set<string>
): void {
  const segments = validateRelativePath(relativePath)
  if (relativePath === SKILL_FILE)
    throw new TypeError('Supporting resources must not redefine SKILL.md')
  const uri = resourceUri(rootUri, segments)
  if (files.has(uri)) throw new TypeError(`Duplicate skill resource: ${uri}`)
  const normalized = normalizeResourceInput(value)
  const bytes = toBytes(normalized.content)
  const binary = detectBinary(bytes, normalized.mimeType)
  if (binary && !source.allowBinary) {
    throw new TypeError(`Binary skill resource requires allowBinary: true: ${relativePath}`)
  }
  files.set(
    uri,
    storedResource(
      uri,
      segments.at(-1) ?? relativePath,
      bytes,
      normalized.mimeType ?? inferMimeType(relativePath, binary),
      binary
    )
  )
  addAncestorDirectories(rootUri, segments, directories)
}

function detectBinary(bytes: Uint8Array, mimeType: string | undefined): boolean {
  if (isBinaryMimeType(mimeType, true)) return true
  try {
    decodeUtf8(bytes, '')
    return false
  } catch {
    return true
  }
}

function addDeclaredDirectories(
  source: McpSkillSource,
  rootUri: string,
  files: Map<string, McpSkillStoredResource>,
  directories: Set<string>
): void {
  for (const relativePath of source.directories ?? []) {
    const segments = validateRelativePath(relativePath)
    const uri = resourceUri(rootUri, segments)
    if (files.has(uri)) throw new TypeError(`Skill directory conflicts with a file: ${uri}`)
    directories.add(uri)
    addAncestorDirectories(rootUri, segments, directories)
  }
}

function resourceUri(rootUri: string, segments: readonly string[]): string {
  return `${rootUri}/${segments.map(encodeURIComponent).join('/')}`
}

function addAncestorDirectories(
  rootUri: string,
  segments: readonly string[],
  directories: Set<string>
): void {
  for (let index = 1; index < segments.length; index += 1) {
    directories.add(resourceUri(rootUri, segments.slice(0, index)))
  }
}

export function findStaticSkillResource(
  skills: Iterable<McpSkillDefinition>,
  uri: string
): { skill: McpSkillDefinition; resource: McpSkillStoredResource } | undefined {
  assertSafeResourceUri(uri)
  let match: { skill: McpSkillDefinition; resource: McpSkillStoredResource } | undefined
  for (const skill of skills) {
    const resource = skill.files.get(uri)
    if (resource && (!match || skill.rootUri.length > match.skill.rootUri.length)) {
      match = { skill, resource }
    }
  }
  return match
}

export function findStaticDynamicSkill(
  skills: Iterable<McpSkillDefinition>,
  uri: string
): McpSkillDefinition | undefined {
  assertSafeResourceUri(uri)
  let match: McpSkillDefinition | undefined
  for (const skill of skills) {
    if (
      skill.entry.resources === 'dynamic' &&
      isWithinSkill(skill.rootUri, uri) &&
      (!match || skill.rootUri.length > match.rootUri.length)
    ) {
      match = skill
    }
  }
  return match
}

export function findSkillDirectoryOwner(
  skills: Iterable<McpSkillDefinition>,
  uri: string
): McpSkillDefinition | undefined {
  const normalized = assertSafeDirectoryUri(uri)
  let match: McpSkillDefinition | undefined
  for (const skill of skills) {
    if (
      isWithinSkill(skill.rootUri, normalized) &&
      (!match || skill.rootUri.length > match.rootUri.length)
    ) {
      match = skill
    }
  }
  return match
}

export function listStaticSkillDirectory(
  skills: Iterable<McpSkillDefinition>,
  directoryUri: string
): { skill: McpSkillDefinition; entries: McpSkillDirectoryEntry[] } | undefined {
  const normalized = assertSafeDirectoryUri(directoryUri)
  let match: { skill: McpSkillDefinition; entries: McpSkillDirectoryEntry[] } | undefined
  for (const skill of skills) {
    if (!isWithinSkill(skill.rootUri, normalized)) continue
    const { exists, entries } = directoryEntriesForSkill(skill, normalized)
    if (exists && (!match || skill.rootUri.length > match.skill.rootUri.length)) {
      match = { skill, entries: [...entries.values()] }
    }
  }
  return match
}

function directoryEntriesForSkill(
  skill: McpSkillDefinition,
  normalized: string
): { exists: boolean; entries: Map<string, McpSkillDirectoryEntry> } {
  const prefix = `${normalized}/`
  const entries = new Map<string, McpSkillDirectoryEntry>()
  let exists = skill.directories.has(normalized)
  for (const resource of skill.files.values()) {
    if (!resource.uri.startsWith(prefix)) continue
    exists = true
    addDirectoryEntry(entries, normalized, resource.uri.slice(prefix.length), resource.mimeType)
  }
  for (const directory of skill.directories) {
    if (!directory.startsWith(prefix)) continue
    exists = true
    addDirectoryEntry(entries, normalized, directory.slice(prefix.length), 'inode/directory')
  }
  return { exists, entries }
}

function addDirectoryEntry(
  entries: Map<string, McpSkillDirectoryEntry>,
  normalized: string,
  remainder: string,
  mimeType: string
): void {
  const [child] = remainder.split('/')
  if (!child) return
  const childUri = `${normalized}/${child}`
  entries.set(childUri, {
    uri: childUri,
    name: decodeURIComponent(child),
    mimeType: remainder.includes('/') ? 'inode/directory' : mimeType
  })
}

export function serializeSkillResource(resource: McpSkillStoredResource): {
  uri: string
  mimeType: string
  text?: string
  blob?: string
} {
  if (resource.binary) {
    return {
      uri: resource.uri,
      mimeType: resource.mimeType,
      blob: Buffer.from(resource.bytes).toString('base64')
    }
  }
  return {
    uri: resource.uri,
    mimeType: resource.mimeType,
    text: decodeUtf8(resource.bytes, `Skill resource is not valid UTF-8: ${resource.uri}`)
  }
}

export function serializeDynamicSkillResource(
  uri: string,
  value: McpSkillResourceValue,
  allowBinary: boolean
): ReturnType<typeof serializeSkillResource> {
  assertSafeResourceUri(uri)
  const input = normalizeResourceInput(value)
  const bytes = toBytes(input.content)
  let binary = isBinaryMimeType(input.mimeType, true)
  try {
    decodeUtf8(bytes, '')
  } catch {
    binary = true
  }
  if (binary && !allowBinary) {
    throw new TypeError(`Binary skill resource requires allowBinary: true: ${uri}`)
  }
  return serializeSkillResource(
    storedResource(
      uri,
      decodeURIComponent(uri.split('/').at(-1) ?? uri),
      bytes,
      input.mimeType ?? inferMimeType(uri, binary),
      binary
    )
  )
}

export function assertSafeResourceUri(uri: string): void {
  parseResourceUri(uri, false)
}

export function assertSafeDirectoryUri(uri: string): string {
  return parseResourceUri(uri, true).normalized
}

export function isWithinSkill(rootUri: string, uri: string): boolean {
  return uri === rootUri || uri.startsWith(`${rootUri}/`)
}

function parseSkillUri(uri: string): { rootUri: string; name: string } {
  const parsed = parseResourceUri(uri, false)
  if (parsed.segments.at(-1) !== SKILL_FILE) {
    throw new TypeError('Skill URI must end with /SKILL.md')
  }
  const name = parsed.segments.at(-2)
  if (!name) throw new TypeError('Skill URI must include a skill directory')
  return { rootUri: uri.slice(0, -`/${SKILL_FILE}`.length), name }
}

function parseResourceUri(
  uri: string,
  directory: boolean
): { normalized: string; segments: string[] } {
  if (typeof uri !== 'string' || uri.length === 0) throw new TypeError('Skill URI is required')
  assertAbsoluteSkillUri(uri)
  if (uri.endsWith('/')) throw new TypeError('Skill resource URIs must not end with a slash')
  if (/[?#]/u.test(uri))
    throw new TypeError('Skill resource URIs must not contain query or fragment')
  return parsedResourceUri(uri, directory)
}

function parsedResourceUri(
  uri: string,
  directory: boolean
): { normalized: string; segments: string[] } {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]+)(\/.*)?$/u.exec(uri)
  if (!match) throw new TypeError(`Invalid absolute skill resource URI: ${uri}`)
  const authority = decodeSegment(match[2] ?? '')
  if (!authority) throw new TypeError('Skill resource authority is required')
  const rawPath = match[3] ?? ''
  const rawSegments = rawPath === '' ? [] : rawPath.slice(1).split('/')
  const segments = [authority, ...rawSegments.map(decodeSegment)]
  if (!directory && rawPath === '') throw new TypeError('Skill file URI requires a path')
  return { normalized: uri, segments }
}

function assertAbsoluteSkillUri(uri: string): void {
  if (!isValidUri(uri) || containsUnsafeUriCharacter(uri)) {
    throw new TypeError(`Invalid absolute skill resource URI: ${uri}`)
  }
}

function containsUnsafeUriCharacter(uri: string): boolean {
  return Array.from(uri).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x20 || code === 0x7f
  })
}

function decodeSegment(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new TypeError('Skill URI contains invalid percent encoding')
  }
  if (
    decoded.length === 0 ||
    decoded === '.' ||
    decoded === '..' ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0')
  ) {
    throw new TypeError('Skill URI contains an unsafe path segment')
  }
  return decoded
}

function validateRelativePath(path: string): string[] {
  if (path.startsWith('/') || path.endsWith('/') || path.includes('\\')) {
    throw new TypeError(`Invalid skill resource path: ${path}`)
  }
  const segments = path.split('/').map(decodeSegment)
  if (segments.length === 0) throw new TypeError('Skill resource path is required')
  return segments
}

function parseFrontmatter(text: string): McpSkill['frontmatter'] {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text
  if (!withoutBom.startsWith('---\n') && !withoutBom.startsWith('---\r\n')) {
    throw new TypeError('SKILL.md must begin with YAML frontmatter')
  }
  const lines = withoutBom.split(/\r?\n/u)
  const closing = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'))
  if (closing < 0) throw new TypeError('SKILL.md frontmatter is not terminated')
  const yaml = lines.slice(1, closing).join('\n')
  const document = parseDocument(yaml, { schema: 'core', uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new TypeError(
      `Invalid SKILL.md frontmatter: ${document.errors[0]?.message ?? 'YAML error'}`
    )
  }
  const value = document.toJS({ mapAsMap: false, maxAliasCount: 100 })
  if (!isRecord(value)) throw new TypeError('SKILL.md frontmatter must be an object')
  assertJsonValue(value)
  return value as McpSkill['frontmatter']
}

function assertFrontmatter(value: McpSkill['frontmatter']): void {
  if (typeof value.name !== 'string') throw new TypeError('Skill name is required')
  if (!validSkillName(value.name)) {
    throw new TypeError('Skill name does not satisfy the Agent Skills naming rules')
  }
  if (!validLengthString(value.description, 1, 1024)) {
    throw new TypeError('Skill description must contain 1 to 1024 characters')
  }
  assertOptionalFrontmatterFields(value)
}

function assertOptionalFrontmatterFields(value: McpSkill['frontmatter']): void {
  if (value.compatibility !== undefined && !validLengthString(value.compatibility, 1, 500)) {
    throw new TypeError('Skill compatibility must contain 1 to 500 characters')
  }
  if (value.metadata !== undefined && !validMetadata(value.metadata)) {
    throw new TypeError('Skill metadata must map string keys to string values')
  }
  for (const field of ['license', 'allowed-tools'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new TypeError(`Skill ${field} must be a string`)
    }
  }
}

function validSkillName(value: string): boolean {
  const length = Array.from(value).length
  if (length < 1 || length > 64) return false
  const normalized = value.normalize('NFKC')
  if (normalized !== normalized.toLocaleLowerCase()) return false
  return /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(normalized)
}

function validLengthString(value: unknown, min: number, max: number): boolean {
  if (typeof value !== 'string') return false
  const length = Array.from(value).length
  return length >= min && length <= max
}

function validMetadata(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function assertJsonValue(value: unknown): void {
  if (isJsonScalar(value)) return
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry)
    return
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) assertJsonValue(entry)
    return
  }
  throw new TypeError('SKILL.md frontmatter must contain only JSON values')
}

function isJsonScalar(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeResourceInput(value: McpSkillResourceValue): McpSkillResourceInput {
  if (typeof value === 'string' || value instanceof Uint8Array) return { content: value }
  if (
    !isRecord(value) ||
    (typeof value.content !== 'string' && !(value.content instanceof Uint8Array)) ||
    (value.mimeType !== undefined &&
      (typeof value.mimeType !== 'string' || value.mimeType.trim().length === 0))
  ) {
    throw new TypeError(
      'Skill resources require string or Uint8Array content and a valid MIME type'
    )
  }
  return { content: value.content, mimeType: value.mimeType }
}

function storedResource(
  uri: string,
  name: string,
  bytes: Uint8Array,
  mimeType: string,
  binary: boolean
): McpSkillStoredResource {
  return { uri, name, bytes: new Uint8Array(bytes), mimeType, binary }
}

function toBytes(value: McpSkillBytes): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)
}

function copyBytes(value: McpSkillBytes): McpSkillBytes {
  return typeof value === 'string' ? value : new Uint8Array(value)
}

function decodeUtf8(bytes: Uint8Array, message: string): string {
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new TypeError(message || 'Invalid UTF-8')
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function inferMimeType(path: string, binary: boolean): string {
  if (binary) return 'application/octet-stream'
  if (/\.md$/iu.test(path)) return 'text/markdown'
  if (/\.json$/iu.test(path)) return 'application/json'
  if (/\.ya?ml$/iu.test(path)) return 'application/yaml'
  return 'text/plain'
}
