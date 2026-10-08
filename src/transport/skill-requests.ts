import type { McpAuthorizationContext } from '../extensions/auth/index.js'
import {
  assertCompatibleSkillDefinitions,
  assertSafeDirectoryUri,
  assertSafeResourceUri,
  createProviderSkillDefinition,
  findSkillDirectoryOwner,
  findStaticDynamicSkill,
  findStaticSkillResource,
  isWithinSkill,
  listStaticSkillDirectory,
  type McpSkillDefinition,
  type McpSkillDirectoryEntry,
  type McpSkillDynamicDirectoryReader,
  serializeDynamicSkillResource,
  serializeSkillResource
} from '../extensions/skills/index.js'
import type { McpServerVariant } from '../extensions/variants/index.js'
import { getMcpRegistry } from '../registry.js'
import type {
  AnyElysiaApp,
  McpAuthorizationOptions,
  McpInvocationContext,
  NormalizedMcpPluginOptions
} from '../types.js'
import { decodeCursor, encodeCursor } from './core.js'
import type { McpRequestProtocolContext } from './protocol.js'

export interface SkillDispatchContext {
  protocol: McpRequestProtocolContext
  authorization?: McpAuthorizationContext
  signal?: AbortSignal
  reportProgress?: McpInvocationContext['reportProgress']
  activeVariant?: McpServerVariant
  sessionId?: string
}

export interface SkillRequestRuntime {
  invocationContext: (
    request: Request,
    method: string,
    params: Record<string, unknown>,
    context: SkillDispatchContext,
    options: NormalizedMcpPluginOptions
  ) => Promise<McpInvocationContext>
  enforceAuthorization: (
    requirement: McpAuthorizationOptions | undefined,
    authorization: McpAuthorizationContext | undefined,
    options: NormalizedMcpPluginOptions
  ) => void
  isAuthorized: (
    requirement: McpAuthorizationOptions | undefined,
    authorization: McpAuthorizationContext | undefined
  ) => boolean
  error: (code: number, message: string, data?: unknown, status?: number) => Error
}

type SkillsConfig = NonNullable<NormalizedMcpPluginOptions['extensions']['skills']>
type SkillsProvider = NonNullable<SkillsConfig['provider']>

function fail(runtime: SkillRequestRuntime, code: number, message: string, data?: unknown): never {
  throw runtime.error(code, message, data)
}

function assertModernSkills(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  context: SkillDispatchContext,
  runtime: SkillRequestRuntime
): void {
  if (!context.protocol.modern) {
    throw runtime.error(-32601, 'Skills require protocol version 2026-07-28', undefined, 404)
  }
  const configured =
    getMcpRegistry(app, options).skills.size > 0 ||
    options.extensions.skills?.provider !== undefined
  if (!configured) throw runtime.error(-32601, 'Skills extension is not enabled', undefined, 404)
}

function visibleStaticSkills(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  runtime: SkillRequestRuntime,
  context: SkillDispatchContext
): McpSkillDefinition[] {
  return [...getMcpRegistry(app, options).skills.values()].filter(
    (skill) => skill.listed && runtime.isAuthorized(skill.authorization, context.authorization)
  )
}

function skillsListOffset(
  params: Record<string, unknown>,
  invocation: McpInvocationContext,
  options: NormalizedMcpPluginOptions,
  runtime: SkillRequestRuntime
): number {
  const pagination = options.extensions.skills?.pagination
  if (!pagination && params.cursor !== undefined) {
    fail(runtime, -32602, 'Skills pagination is not configured')
  }
  const offset = pagination
    ? decodeCursor(params.cursor, 'skills/list', params, invocation, options, pagination)
    : 0
  if (offset < 0) fail(runtime, -32602, 'Invalid skills pagination cursor')
  return offset
}

interface SkillListState {
  visible: McpSkillDefinition[]
  providerDefinitions: McpSkillDefinition[]
  providerOffset: number
  providerTouched: boolean
  hasMore: boolean
}

function initialSkillListState(
  staticSkills: McpSkillDefinition[],
  offset: number,
  config: SkillsConfig | undefined
): SkillListState {
  const limit = config?.pagination?.pageSize
  const visible =
    offset < staticSkills.length
      ? staticSkills.slice(offset, offset + (limit ?? staticSkills.length))
      : []
  return {
    visible,
    providerDefinitions: [],
    providerOffset: Math.max(0, offset - staticSkills.length),
    providerTouched: offset >= staticSkills.length,
    hasMore:
      offset + visible.length < staticSkills.length ||
      (config?.provider !== undefined && offset < staticSkills.length)
  }
}

function assertProviderPage(
  page: Awaited<ReturnType<SkillsProvider['list']>>,
  limit: number | undefined,
  runtime: SkillRequestRuntime
): asserts page is NonNullable<typeof page> {
  const shapeValid =
    !!page &&
    Array.isArray(page.skills) &&
    (page.hasMore === undefined || typeof page.hasMore === 'boolean')
  if (!shapeValid) fail(runtime, -32603, 'Skills provider returned an invalid page')
  if (limit !== undefined && page.skills.length > Math.max(1, limit)) {
    fail(runtime, -32603, 'Skills provider exceeded the requested page size')
  }
  if (page.hasMore && page.skills.length === 0) {
    fail(runtime, -32603, 'Skills provider returned an empty non-terminal page')
  }
}

async function validatedProviderDefinition(
  source: Parameters<typeof createProviderSkillDefinition>[0],
  provider: SkillsProvider,
  existing: readonly McpSkillDefinition[],
  invocation: McpInvocationContext,
  directoryRead: boolean,
  runtime: SkillRequestRuntime
): Promise<McpSkillDefinition> {
  try {
    const definition = createProviderSkillDefinition(source)
    assertProviderDirectorySupport(provider, definition, directoryRead)
    assertCompatibleSkillDefinitions(existing, definition)
    await assertProviderAncestorCompatibility(
      provider,
      definition,
      invocation,
      [...existing, definition],
      directoryRead
    )
    return definition
  } catch (error) {
    throw providerSkillError(error, runtime)
  }
}

async function appendProviderSkills(
  state: SkillListState,
  staticSkills: readonly McpSkillDefinition[],
  config: SkillsConfig,
  invocation: McpInvocationContext,
  context: SkillDispatchContext,
  runtime: SkillRequestRuntime
): Promise<void> {
  const provider = config.provider
  if (!provider) return
  const limit = config.pagination?.pageSize
  if (limit !== undefined && state.visible.length >= limit) return
  state.providerTouched = true
  const providerLimit = limit === undefined ? undefined : limit - state.visible.length
  const page = await provider.list(
    {
      offset: state.providerOffset,
      limit: providerLimit === undefined ? undefined : Math.max(1, providerLimit)
    },
    invocation
  )
  assertProviderPage(page, providerLimit, runtime)
  state.providerOffset += page.skills.length
  for (const source of page.skills) {
    await appendProviderDefinition(
      source,
      provider,
      staticSkills,
      state,
      invocation,
      config.directoryRead,
      context,
      runtime
    )
  }
  state.hasMore = page.hasMore === true
}

async function appendProviderDefinition(
  source: Parameters<typeof createProviderSkillDefinition>[0],
  provider: SkillsProvider,
  staticSkills: readonly McpSkillDefinition[],
  state: SkillListState,
  invocation: McpInvocationContext,
  directoryRead: boolean,
  context: SkillDispatchContext,
  runtime: SkillRequestRuntime
): Promise<void> {
  const definition = await validatedProviderDefinition(
    source,
    provider,
    [...staticSkills, ...state.providerDefinitions],
    invocation,
    directoryRead,
    runtime
  )
  const visible =
    definition.listed && runtime.isAuthorized(definition.authorization, context.authorization)
  if (visible) state.visible.push(definition)
  state.providerDefinitions.push(definition)
}

export async function listSkills(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: SkillDispatchContext,
  runtime: SkillRequestRuntime
): Promise<Record<string, unknown>> {
  assertModernSkills(app, options, context, runtime)
  const invocation = await runtime.invocationContext(
    request,
    'skills/list',
    params,
    context,
    options
  )
  const config = options.extensions.skills
  if (config) runtime.enforceAuthorization(config.authorization, context.authorization, options)
  const staticSkills = visibleStaticSkills(app, options, runtime, context)
  const offset = skillsListOffset(params, invocation, options, runtime)
  const state = initialSkillListState(staticSkills, offset, config)
  if (config) await appendProviderSkills(state, staticSkills, config, invocation, context, runtime)
  if (!config?.pagination && state.hasMore) {
    fail(runtime, -32603, 'Skills provider requires pagination configuration')
  }
  const nextOffset = state.providerTouched
    ? staticSkills.length + state.providerOffset
    : offset + state.visible.length
  const cache = config?.cache ?? { cacheScope: 'private' as const, ttlMs: 0 }
  return {
    resultType: 'complete',
    skills: state.visible.map((skill) => skill.entry),
    ttlMs: cache.ttlMs,
    cacheScope: cache.cacheScope,
    ...(state.hasMore
      ? {
          nextCursor: encodeCursor(
            'skills/list',
            nextOffset,
            params,
            invocation,
            options,
            config?.pagination
          )
        }
      : {})
  }
}

function assertSkillUri(uri: unknown, runtime: SkillRequestRuntime): asserts uri is string {
  if (typeof uri !== 'string') fail(runtime, -32602, 'skills/get requires a uri')
  try {
    assertSafeResourceUri(uri)
  } catch (error) {
    fail(runtime, -32602, 'Invalid skill URI', error)
  }
}

async function providerSkill(
  uri: string,
  config: SkillsConfig,
  existing: readonly McpSkillDefinition[],
  invocation: McpInvocationContext,
  runtime: SkillRequestRuntime
): Promise<McpSkillDefinition | undefined> {
  const source = await config.provider?.get(uri, invocation)
  if (!source || !config.provider) return undefined
  const definition = await validatedProviderDefinition(
    source,
    config.provider,
    existing,
    invocation,
    config.directoryRead,
    runtime
  )
  if (definition.uri !== uri)
    fail(runtime, -32603, 'Skills provider returned a different skill URI')
  return definition
}

export async function getSkill(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: SkillDispatchContext,
  runtime: SkillRequestRuntime
): Promise<Record<string, unknown>> {
  assertModernSkills(app, options, context, runtime)
  assertSkillUri(params.uri, runtime)
  const invocation = await runtime.invocationContext(
    request,
    'skills/get',
    params,
    context,
    options
  )
  const registry = getMcpRegistry(app, options)
  const config = options.extensions.skills
  let definition = registry.skills.get(params.uri)
  if (!definition && config?.provider) {
    runtime.enforceAuthorization(config.authorization, context.authorization, options)
    definition = await providerSkill(
      params.uri,
      config,
      [...registry.skills.values()],
      invocation,
      runtime
    )
  }
  if (!definition) fail(runtime, -32602, `No skill is served at ${params.uri}`)
  if (config) runtime.enforceAuthorization(config.authorization, context.authorization, options)
  runtime.enforceAuthorization(definition.authorization, context.authorization, options)
  const cache = config?.cache ?? { cacheScope: 'private' as const, ttlMs: 0 }
  return {
    resultType: 'complete',
    skill: definition.entry,
    ttlMs: cache.ttlMs,
    cacheScope: cache.cacheScope
  }
}

function authorizeSkill(
  definition: McpSkillDefinition,
  config: SkillsConfig | undefined,
  context: SkillDispatchContext,
  options: NormalizedMcpPluginOptions,
  runtime: SkillRequestRuntime
): void {
  if (config) runtime.enforceAuthorization(config.authorization, context.authorization, options)
  runtime.enforceAuthorization(definition.authorization, context.authorization, options)
}

async function readLocalDynamicResource(
  definition: McpSkillDefinition,
  uri: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: SkillDispatchContext,
  runtime: SkillRequestRuntime
): Promise<Record<string, unknown> | undefined> {
  authorizeSkill(definition, options.extensions.skills, context, options, runtime)
  if (!definition.readResource) return undefined
  const invocation = await runtime.invocationContext(
    request,
    'resources/read',
    params,
    context,
    options
  )
  const value = await definition.readResource(uri, invocation)
  if (value === null) return undefined
  return { contents: [serializeDynamicSkillResource(uri, value, definition.allowBinary)] }
}

async function readProviderResource(
  uri: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: SkillDispatchContext,
  runtime: SkillRequestRuntime,
  existing: Iterable<McpSkillDefinition>
): Promise<Record<string, unknown> | undefined> {
  const config = options.extensions.skills
  if (!config?.provider) return undefined
  runtime.enforceAuthorization(config.authorization, context.authorization, options)
  const invocation = await runtime.invocationContext(
    request,
    'resources/read',
    params,
    context,
    options
  )
  const owner = await providerSkillOwner(
    config.provider,
    uri,
    invocation,
    existing,
    false,
    config.directoryRead,
    runtime
  )
  if (!owner) return undefined
  runtime.enforceAuthorization(owner.authorization, context.authorization, options)
  const stable = owner.files.get(uri)
  if (stable) return { contents: [serializeSkillResource(stable)] }
  if (owner.entry.resources !== 'dynamic') return undefined
  const value = await config.provider.read(uri, invocation)
  if (value === null) return undefined
  return { contents: [serializeDynamicSkillResource(uri, value, owner.allowBinary)] }
}

export async function readSkillResource(
  app: AnyElysiaApp,
  uri: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: SkillDispatchContext,
  runtime: SkillRequestRuntime
): Promise<Record<string, unknown> | undefined> {
  try {
    assertSafeResourceUri(uri)
  } catch {
    return undefined
  }
  const registry = getMcpRegistry(app, options)
  const local = findStaticSkillResource(registry.skills.values(), uri)
  if (local) {
    authorizeSkill(local.skill, options.extensions.skills, context, options, runtime)
    return { contents: [serializeSkillResource(local.resource)] }
  }
  const localDynamic = findStaticDynamicSkill(registry.skills.values(), uri)
  if (localDynamic) {
    return readLocalDynamicResource(localDynamic, uri, params, request, options, context, runtime)
  }
  return readProviderResource(
    uri,
    params,
    request,
    options,
    context,
    runtime,
    registry.skills.values()
  )
}

function directoryUri(params: Record<string, unknown>, runtime: SkillRequestRuntime): string {
  if (typeof params.uri !== 'string') fail(runtime, -32602, 'Directory read requires a uri')
  try {
    assertSafeDirectoryUri(params.uri)
  } catch (error) {
    fail(runtime, -32602, 'Invalid skill directory URI', error)
  }
  return params.uri
}

function directoryOffset(
  params: Record<string, unknown>,
  invocation: McpInvocationContext,
  options: NormalizedMcpPluginOptions,
  config: SkillsConfig,
  runtime: SkillRequestRuntime
): number {
  const pagination = config.pagination
  if (!pagination && params.cursor !== undefined) {
    fail(runtime, -32602, 'Skills directory pagination is not configured')
  }
  return pagination
    ? decodeCursor(
        params.cursor,
        'resources/directory/read',
        params,
        invocation,
        options,
        pagination
      )
    : 0
}

interface DirectoryPage {
  entries: readonly McpSkillDirectoryEntry[]
  hasMore: boolean
}

function staticDirectoryPage(
  entries: readonly McpSkillDirectoryEntry[],
  offset: number,
  pageSize: number | undefined,
  runtime: SkillRequestRuntime
): DirectoryPage {
  if (offset > entries.length) fail(runtime, -32602, 'Invalid directory cursor')
  const end = pageSize === undefined ? entries.length : Math.min(offset + pageSize, entries.length)
  return { entries: entries.slice(offset, end), hasMore: end < entries.length }
}

async function localDirectoryPage(
  owner: McpSkillDefinition,
  localEntries: readonly McpSkillDirectoryEntry[],
  uri: string,
  offset: number,
  config: SkillsConfig,
  invocation: McpInvocationContext,
  runtime: SkillRequestRuntime
): Promise<DirectoryPage | undefined> {
  if (owner.entry.resources !== 'dynamic') {
    return staticDirectoryPage(localEntries, offset, config.pagination?.pageSize, runtime)
  }
  if (!owner.readDirectory) {
    fail(runtime, -32603, 'Dynamic skill does not implement directory enumeration')
  }
  return readDynamicSkillDirectoryPage(
    owner.readDirectory,
    uri,
    localEntries,
    offset,
    config.pagination?.pageSize,
    invocation,
    owner,
    runtime
  )
}

async function providerDirectoryPage(
  provider: SkillsProvider,
  owner: McpSkillDefinition,
  uri: string,
  offset: number,
  config: SkillsConfig,
  invocation: McpInvocationContext,
  runtime: SkillRequestRuntime
): Promise<DirectoryPage | undefined> {
  const computed = listStaticSkillDirectory([owner], uri)
  if (owner.entry.resources !== 'dynamic') {
    return computed
      ? staticDirectoryPage(computed.entries, offset, config.pagination?.pageSize, runtime)
      : undefined
  }
  if (!provider.readDirectory) {
    fail(runtime, -32603, 'Skills provider does not implement directory enumeration')
  }
  return readDynamicSkillDirectoryPage(
    provider.readDirectory.bind(provider),
    uri,
    computed?.entries ?? [],
    offset,
    config.pagination?.pageSize,
    invocation,
    owner,
    runtime
  )
}

async function resolveDirectoryPage(
  app: AnyElysiaApp,
  uri: string,
  offset: number,
  config: SkillsConfig,
  invocation: McpInvocationContext,
  options: NormalizedMcpPluginOptions,
  context: SkillDispatchContext,
  runtime: SkillRequestRuntime
): Promise<DirectoryPage | undefined> {
  const registry = getMcpRegistry(app, options)
  const owner = findSkillDirectoryOwner(registry.skills.values(), uri)
  const local = listStaticSkillDirectory(registry.skills.values(), uri)
  if (owner?.entry.resources === 'dynamic') {
    runtime.enforceAuthorization(owner.authorization, context.authorization, options)
    const knownEntries = local?.skill === owner ? local.entries : []
    return localDirectoryPage(owner, knownEntries, uri, offset, config, invocation, runtime)
  }
  if (owner && local?.skill === owner) {
    runtime.enforceAuthorization(owner.authorization, context.authorization, options)
    return localDirectoryPage(owner, local.entries, uri, offset, config, invocation, runtime)
  }
  if (!config.provider) return undefined
  const providerOwner = await providerSkillOwner(
    config.provider,
    uri,
    invocation,
    registry.skills.values(),
    true,
    config.directoryRead,
    runtime
  )
  if (!providerOwner) return undefined
  runtime.enforceAuthorization(providerOwner.authorization, context.authorization, options)
  return providerDirectoryPage(
    config.provider,
    providerOwner,
    uri,
    offset,
    config,
    invocation,
    runtime
  )
}

export async function readSkillDirectory(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: SkillDispatchContext,
  runtime: SkillRequestRuntime
): Promise<Record<string, unknown>> {
  assertModernSkills(app, options, context, runtime)
  const config = options.extensions.skills
  if (!config?.directoryRead) {
    throw runtime.error(-32601, 'Method not found: resources/directory/read', undefined, 404)
  }
  const uri = directoryUri(params, runtime)
  runtime.enforceAuthorization(config.authorization, context.authorization, options)
  const invocation = await runtime.invocationContext(
    request,
    'resources/directory/read',
    params,
    context,
    options
  )
  const offset = directoryOffset(params, invocation, options, config, runtime)
  const page = await resolveDirectoryPage(
    app,
    uri,
    offset,
    config,
    invocation,
    options,
    context,
    runtime
  )
  if (!page) fail(runtime, -32602, `${uri} is not a directory resource`)
  if (!config.pagination && page.hasMore) {
    fail(runtime, -32603, 'Dynamic directory reader requires pagination configuration')
  }
  return {
    resultType: 'complete',
    resources: page.entries,
    ...(page.hasMore
      ? {
          nextCursor: encodeCursor(
            'resources/directory/read',
            offset + page.entries.length,
            params,
            invocation,
            options,
            config.pagination
          )
        }
      : {})
  }
}

function initialDynamicEntries(
  knownEntries: readonly McpSkillDirectoryEntry[],
  offset: number,
  pageSize: number | undefined
): McpSkillDirectoryEntry[] {
  if (offset >= knownEntries.length) return []
  const end = pageSize === undefined ? undefined : offset + pageSize
  return knownEntries.slice(offset, end)
}

function assertDynamicDirectoryPage(
  page: NonNullable<Awaited<ReturnType<McpSkillDynamicDirectoryReader>>>,
  limit: number | undefined,
  runtime: SkillRequestRuntime
): void {
  const valid =
    Array.isArray(page.resources) &&
    (page.hasMore === undefined || typeof page.hasMore === 'boolean') &&
    (limit === undefined || page.resources.length <= limit) &&
    (!page.hasMore || page.resources.length > 0)
  if (!valid) {
    fail(runtime, -32603, 'Dynamic skill directory reader returned an invalid page')
  }
}

async function readDynamicSkillDirectoryPage(
  reader: McpSkillDynamicDirectoryReader,
  uri: string,
  knownEntries: readonly McpSkillDirectoryEntry[],
  offset: number,
  pageSize: number | undefined,
  context: McpInvocationContext,
  owner: McpSkillDefinition,
  runtime: SkillRequestRuntime
): Promise<DirectoryPage | undefined> {
  const entries = initialDynamicEntries(knownEntries, offset, pageSize)
  if (pageSize !== undefined && entries.length === pageSize) return { entries, hasMore: true }
  const dynamicOffset = Math.max(0, offset - knownEntries.length)
  const dynamicLimit = pageSize === undefined ? undefined : pageSize - entries.length
  const page = await reader(uri, { offset: dynamicOffset, limit: dynamicLimit }, context)
  if (!page) {
    const knownDirectory = knownEntries.length > 0 && offset <= knownEntries.length
    return knownDirectory ? { entries, hasMore: false } : undefined
  }
  assertDynamicDirectoryPage(page, dynamicLimit, runtime)
  const dynamicEntries = validateSkillDirectoryEntries(page.resources, uri, owner, runtime)
  const knownUris = new Set(knownEntries.map((entry) => entry.uri))
  if (dynamicEntries.some((entry) => knownUris.has(entry.uri))) {
    fail(runtime, -32603, 'Dynamic skill directory reader returned an adapter-managed resource')
  }
  entries.push(...dynamicEntries)
  return { entries, hasMore: page.hasMore === true }
}

async function providerSkillOwner(
  provider: SkillsProvider,
  resourceUri: string,
  context: McpInvocationContext,
  existing: Iterable<McpSkillDefinition>,
  includeSelf: boolean,
  directoryRead: boolean,
  runtime: SkillRequestRuntime
): Promise<McpSkillDefinition | undefined> {
  const known = [...existing]
  let owner: McpSkillDefinition | undefined
  for (const candidate of candidateSkillUris(resourceUri, includeSelf)) {
    const source = await provider.get(candidate, context)
    if (!source) continue
    const definition = providerOwnerDefinition(
      source,
      provider,
      known,
      resourceUri,
      candidate,
      directoryRead,
      runtime
    )
    owner ??= definition
    known.push(definition)
  }
  return owner
}

function providerOwnerDefinition(
  source: Parameters<typeof createProviderSkillDefinition>[0],
  provider: SkillsProvider,
  existing: readonly McpSkillDefinition[],
  resourceUri: string,
  candidate: string,
  directoryRead: boolean,
  runtime: SkillRequestRuntime
): McpSkillDefinition {
  let definition: McpSkillDefinition
  try {
    definition = createProviderSkillDefinition(source)
    assertProviderDirectorySupport(provider, definition, directoryRead)
    assertCompatibleSkillDefinitions(existing, definition)
  } catch (error) {
    throw providerSkillError(error, runtime)
  }
  if (definition.uri !== candidate || !isWithinSkill(definition.rootUri, resourceUri)) {
    fail(runtime, -32603, 'Skills provider violated resource ownership')
  }
  return definition
}

async function assertProviderAncestorCompatibility(
  provider: SkillsProvider,
  definition: McpSkillDefinition,
  context: McpInvocationContext,
  existing: readonly McpSkillDefinition[],
  directoryRead: boolean
): Promise<void> {
  const known = [...existing]
  for (const candidate of candidateSkillUris(definition.rootUri, false)) {
    if (known.some((skill) => skill.uri === candidate)) continue
    const source = await provider.get(candidate, context)
    if (!source) continue
    const ancestor = createProviderSkillDefinition(source)
    assertProviderDirectorySupport(provider, ancestor, directoryRead)
    if (ancestor.uri !== candidate) {
      throw new TypeError('Skills provider returned a different ancestor skill URI')
    }
    assertCompatibleSkillDefinitions(known, ancestor)
    known.push(ancestor)
  }
}

function assertProviderDirectorySupport(
  provider: SkillsProvider,
  definition: McpSkillDefinition,
  directoryRead: boolean
): void {
  const missingReader =
    directoryRead && definition.entry.resources === 'dynamic' && !provider.readDirectory
  if (missingReader) {
    throw new MissingProviderDirectoryReaderError(
      `Dynamic provider skill ${definition.uri} requires readDirectory when directoryRead is enabled`
    )
  }
}

class MissingProviderDirectoryReaderError extends Error {}

function providerSkillError(error: unknown, runtime: SkillRequestRuntime): Error {
  return error instanceof MissingProviderDirectoryReaderError
    ? runtime.error(-32603, error.message)
    : runtime.error(-32603, 'Skills provider returned an invalid skill', error)
}

function candidateSkillUris(uri: string, includeSelf: boolean): string[] {
  const values: string[] = includeSelf ? [`${uri}/SKILL.md`] : []
  let cursor = uri.lastIndexOf('/')
  const authorityEnd = uri.indexOf('://') + 2
  while (cursor > authorityEnd) {
    const directory = uri.slice(0, cursor)
    values.push(`${directory}/SKILL.md`)
    cursor = directory.lastIndexOf('/')
  }
  return [...new Set(values)]
}

function validateSkillDirectoryEntry(
  entry: McpSkillDirectoryEntry,
  prefix: string,
  owner: McpSkillDefinition,
  runtime: SkillRequestRuntime
): McpSkillDirectoryEntry {
  assertDirectoryEntryShape(entry, runtime)
  try {
    assertSafeResourceUri(entry.uri)
  } catch (error) {
    fail(runtime, -32603, 'Directory provider returned an unsafe resource URI', error)
  }
  assertDirectoryEntryOwnership(entry, prefix, owner, runtime)
  return {
    uri: entry.uri,
    name: entry.name,
    ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
    ...(entry.size !== undefined ? { size: entry.size } : {})
  }
}

function assertDirectoryEntryShape(
  entry: McpSkillDirectoryEntry,
  runtime: SkillRequestRuntime
): void {
  if (!entry || typeof entry.uri !== 'string' || typeof entry.name !== 'string') {
    fail(runtime, -32603, 'Directory provider returned an invalid resource')
  }
  if (entry.mimeType !== undefined && typeof entry.mimeType !== 'string') {
    fail(runtime, -32603, 'Directory provider returned an invalid MIME type')
  }
  if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
    fail(runtime, -32603, 'Directory provider returned an invalid resource size')
  }
}

function assertDirectoryEntryOwnership(
  entry: McpSkillDirectoryEntry,
  prefix: string,
  owner: McpSkillDefinition,
  runtime: SkillRequestRuntime
): void {
  const remainder = entry.uri.startsWith(prefix) ? entry.uri.slice(prefix.length) : ''
  const directChild = remainder.length > 0 && !remainder.includes('/')
  if (!directChild || !isWithinSkill(owner.rootUri, entry.uri)) {
    fail(runtime, -32603, 'Directory provider returned a non-child resource')
  }
  if (decodeURIComponent(remainder) !== entry.name) {
    fail(runtime, -32603, 'Directory provider resource name does not match its URI')
  }
}

function validateSkillDirectoryEntries(
  entries: readonly McpSkillDirectoryEntry[],
  directoryUri: string,
  owner: McpSkillDefinition,
  runtime: SkillRequestRuntime
): McpSkillDirectoryEntry[] {
  if (!Array.isArray(entries))
    fail(runtime, -32603, 'Directory provider returned invalid resources')
  const seen = new Set<string>()
  return entries.map((entry) => {
    const validated = validateSkillDirectoryEntry(entry, `${directoryUri}/`, owner, runtime)
    if (seen.has(validated.uri)) {
      fail(runtime, -32603, 'Directory provider returned a duplicate resource')
    }
    seen.add(validated.uri)
    return validated
  })
}
