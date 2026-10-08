import { randomUUID } from 'node:crypto'
import { LEGACY_PROTOCOL_VERSION } from '../constants.js'
import { MCP_APPS_EXTENSION_ID, MCP_APPS_RESOURCE_MIME_TYPE } from '../extensions/apps/index.js'
import { authProfileCapabilities, type McpAuthorizationContext } from '../extensions/auth/index.js'
import { initializeEventSession } from '../extensions/events/index.js'
import { MCP_INTERCEPTORS_ID } from '../extensions/interceptors/index.js'
import { MCP_SKILLS_EXTENSION_ID } from '../extensions/skills/index.js'
import {
  MCP_SERVER_VARIANTS_ID,
  type McpServerVariant,
  type McpVariantHints
} from '../extensions/variants/index.js'
import { getMcpRegistry } from '../registry.js'
import type { AnyElysiaApp, NormalizedMcpPluginOptions } from '../types.js'
import { invocationContextBase } from './invocation-context.js'
import { serverDiscoverResult } from './protocol.js'
import {
  publicVariant,
  rankVariants,
  type VariantSelectionRuntime,
  variantHints,
  variantPrincipal
} from './variant-selection.js'
import { variantSessions } from './variant-subscriptions.js'

const INITIALIZED_SESSION_IDS = new WeakMap<Request, string>()

export interface DiscoveryRuntime extends VariantSelectionRuntime {
  interceptorCapabilities: (app: AnyElysiaApp) => { supportedEvents: string[] }
}

export function initializedSessionId(request: Request): string | undefined {
  return INITIALIZED_SESSION_IDS.get(request)
}

function appCapabilities(): Record<string, unknown> {
  return { mimeTypes: [MCP_APPS_RESOURCE_MIME_TYPE] }
}

function legacyInvocationContext(
  request: Request,
  params: Record<string, unknown>,
  authorization: McpAuthorizationContext | undefined
) {
  return invocationContextBase(request, params, {
    protocol: {
      modern: false,
      version: LEGACY_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: undefined,
      meta: undefined
    },
    authorization
  })
}

async function visibleVariants(
  request: Request,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  runtime: DiscoveryRuntime
): Promise<{ ranked: McpServerVariant[]; hints: McpVariantHints | undefined }> {
  const context = legacyInvocationContext(request, params, authorization)
  const hints = variantHints(params, runtime)
  const visible: McpServerVariant[] = []
  for (const variant of options.extensions.variants?.variants ?? []) {
    if ((await options.extensions.variants?.visible?.(variant, context)) ?? true)
      visible.push(variant)
  }
  return { ranked: await rankVariants(visible, hints, context, options), hints }
}

function prefersExperimental(hints: McpVariantHints | undefined): boolean {
  return Object.values(hints?.hints ?? {})
    .flat()
    .includes('experimental')
}

function preferStableVariant(
  ranked: McpServerVariant[],
  hints: McpVariantHints | undefined,
  runtime: DiscoveryRuntime
): void {
  if (prefersExperimental(hints) || (ranked[0]?.status ?? 'stable') === 'stable') return
  const stableIndex = ranked.findIndex(({ status }) => (status ?? 'stable') === 'stable')
  if (stableIndex < 0) throw runtime.error(-32603, 'No stable server variant is visible')
  const [stable] = ranked.splice(stableIndex, 1)
  if (stable) ranked.unshift(stable)
}

function discoveryVariantLimit(
  ranked: readonly McpServerVariant[],
  options: NormalizedMcpPluginOptions
): number {
  const configured = options.extensions.variants?.discoveryLimit ?? 1
  return ranked.length > 1 ? Math.max(2, configured) : configured
}

function storeVariantSession(
  app: AnyElysiaApp,
  request: Request,
  available: readonly McpServerVariant[],
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined
): void {
  const sessionId = randomUUID()
  variantSessions(app, options).set(sessionId, {
    principal: variantPrincipal(authorization),
    variants: available.map((variant) => structuredClone(variant)),
    streams: new Map(),
    subscriptions: new Map()
  })
  INITIALIZED_SESSION_IDS.set(request, sessionId)
}

async function initializeVariantExtension(
  app: AnyElysiaApp,
  request: Request,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  runtime: DiscoveryRuntime
): Promise<{ payload: Record<string, unknown>; selected?: string }> {
  const { ranked, hints } = await visibleVariants(request, params, options, authorization, runtime)
  preferStableVariant(ranked, hints, runtime)
  const available = ranked.slice(0, discoveryVariantLimit(ranked, options))
  if (available.length === 0) throw runtime.error(-32603, 'No server variants are visible')
  storeVariantSession(app, request, available, options, authorization)
  return {
    payload: {
      availableVariants: available.map(publicVariant),
      moreVariantsAvailable: ranked.length > available.length
    },
    selected: available[0]?.id
  }
}

async function legacyExtensions(
  app: AnyElysiaApp,
  request: Request,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  runtime: DiscoveryRuntime
): Promise<{ extensions: Record<string, unknown>; selectedVariant?: string }> {
  const extensions: Record<string, unknown> = {}
  if (options.extensions.apps) extensions[MCP_APPS_EXTENSION_ID] = appCapabilities()
  if (options.extensions.interceptors) {
    extensions[MCP_INTERCEPTORS_ID] = runtime.interceptorCapabilities(app)
  }
  if (!options.extensions.variants) return { extensions }
  const variant = await initializeVariantExtension(
    app,
    request,
    params,
    options,
    authorization,
    runtime
  )
  extensions[MCP_SERVER_VARIANTS_ID] = variant.payload
  return { extensions, selectedVariant: variant.selected }
}

function initializeEvents(
  app: AnyElysiaApp,
  request: Request,
  selectedVariant: string | undefined,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined
): void {
  if (!options.extensions.events) return
  const sessionId = initializeEventSession(
    app,
    variantPrincipal(authorization),
    selectedVariant,
    INITIALIZED_SESSION_IDS.get(request),
    options
  )
  INITIALIZED_SESSION_IDS.set(request, sessionId)
}

export async function initializeResult(
  app: AnyElysiaApp,
  request: Request,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  runtime: DiscoveryRuntime
): Promise<Record<string, unknown>> {
  const { extensions, selectedVariant } = await legacyExtensions(
    app,
    request,
    params,
    options,
    authorization,
    runtime
  )
  initializeEvents(app, request, selectedVariant, options, authorization)
  return {
    protocolVersion: options.transport.protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: {
        subscribe: options.core.subscriptions?.resources ?? false,
        listChanged: options.core.subscriptions?.resourcesListChanged ?? false
      },
      prompts: { listChanged: false },
      ...(options.extensions.events
        ? { events: { listChanged: options.transport.enableGetSse } }
        : {}),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {})
    },
    serverInfo: {
      name: options.server.name,
      version: options.server.version,
      title: options.server.title
    },
    instructions: options.server.instructions
  }
}

function modernExtensions(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  skillsEnabled: boolean,
  runtime: DiscoveryRuntime
): Record<string, unknown> {
  const extensions: Record<string, unknown> = {}
  if (options.extensions.tasks) extensions['io.modelcontextprotocol/tasks'] = {}
  if (options.extensions.apps) extensions[MCP_APPS_EXTENSION_ID] = appCapabilities()
  if (options.extensions.auth) {
    Object.assign(extensions, authProfileCapabilities(options.extensions.auth.profiles))
  }
  if (options.extensions.interceptors) {
    extensions[MCP_INTERCEPTORS_ID] = runtime.interceptorCapabilities(app)
  }
  if (skillsEnabled) {
    extensions[MCP_SKILLS_EXTENSION_ID] = {
      directoryRead: options.extensions.skills?.directoryRead ?? false
    }
  }
  return extensions
}

function modernPrimitiveCapabilities(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  skillsEnabled: boolean
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)
  const capabilities: Record<string, unknown> = {}
  addToolCapabilities(capabilities, registry.tools.size, options)
  addResourceCapabilities(
    capabilities,
    registry.resources.size + registry.resourceTemplates.size,
    skillsEnabled,
    options
  )
  addPromptCapabilities(capabilities, registry.prompts.size, options)
  addCompletionCapabilities(capabilities, registry)
  return capabilities
}

function addToolCapabilities(
  capabilities: Record<string, unknown>,
  toolCount: number,
  options: NormalizedMcpPluginOptions
): void {
  if (toolCount === 0) return
  capabilities.tools = { listChanged: options.core.subscriptions?.toolsListChanged ?? false }
}

function addResourceCapabilities(
  capabilities: Record<string, unknown>,
  resourceCount: number,
  skillsEnabled: boolean,
  options: NormalizedMcpPluginOptions
): void {
  if (resourceCount === 0 && !skillsEnabled) return
  capabilities.resources = {
    subscribe: options.core.subscriptions?.resources ?? false,
    listChanged: options.core.subscriptions?.resourcesListChanged ?? false
  }
}

function addPromptCapabilities(
  capabilities: Record<string, unknown>,
  promptCount: number,
  options: NormalizedMcpPluginOptions
): void {
  if (promptCount === 0) return
  capabilities.prompts = { listChanged: options.core.subscriptions?.promptsListChanged ?? false }
}

function addCompletionCapabilities(
  capabilities: Record<string, unknown>,
  registry: ReturnType<typeof getMcpRegistry>
): void {
  const definitions = [...registry.prompts.values(), ...registry.resourceTemplates.values()]
  if (definitions.some((item) => item.complete)) capabilities.completions = {}
}

export function modernDiscoverResult(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  runtime: DiscoveryRuntime
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)
  const skillsEnabled =
    registry.skills.size > 0 || options.extensions.skills?.provider !== undefined
  const extensions = modernExtensions(app, options, skillsEnabled, runtime)
  return {
    ...serverDiscoverResult(options),
    capabilities: {
      ...modernPrimitiveCapabilities(app, options, skillsEnabled),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {})
    }
  }
}
