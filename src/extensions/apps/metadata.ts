import { MCP_APPS_RESOURCE_URI_META_KEY } from './constants.js'
import type {
  McpAppsResourceMeta,
  McpAppsResourceMetadata,
  McpAppsToolMetadata,
  McpAppsVisibility
} from './types.js'
import { assertMcpAppsResourceUri } from './validation.js'

const DEFAULT_VISIBILITY: readonly McpAppsVisibility[] = ['model', 'app']

export function getMcpAppsToolResourceUri(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined

  const ui = isRecord(metadata.ui) ? metadata.ui : undefined
  const nestedUri = ui?.resourceUri
  const legacyUri = metadata[MCP_APPS_RESOURCE_URI_META_KEY]

  if (nestedUri !== undefined) {
    assertMcpAppsResourceUri(nestedUri, '_meta.ui.resourceUri')
    return nestedUri
  }
  if (legacyUri !== undefined) {
    assertMcpAppsResourceUri(legacyUri, `_meta["${MCP_APPS_RESOURCE_URI_META_KEY}"]`)
    return legacyUri
  }
  return undefined
}

export function normalizeMcpAppsToolMetadata(metadata: McpAppsToolMetadata): McpAppsToolMetadata {
  const resourceUri = getMcpAppsToolResourceUri(metadata)
  const ui = isRecord(metadata.ui) ? metadata.ui : undefined
  const visibility = normalizeVisibility(ui?.visibility)

  return {
    ...metadata,
    ...(ui || resourceUri
      ? {
          ui: {
            ...ui,
            ...(resourceUri ? { resourceUri } : {}),
            ...(visibility ? { visibility } : {})
          }
        }
      : {}),
    ...(resourceUri ? { [MCP_APPS_RESOURCE_URI_META_KEY]: resourceUri } : {})
  }
}

export function getMcpAppsToolVisibility(metadata: unknown): McpAppsVisibility[] {
  if (!isRecord(metadata) || !isRecord(metadata.ui) || metadata.ui.visibility === undefined) {
    return [...DEFAULT_VISIBILITY]
  }

  return normalizeVisibility(metadata.ui.visibility) ?? [...DEFAULT_VISIBILITY]
}

export function resolveMcpAppsResourceMeta(
  listingMetadata: McpAppsResourceMetadata | undefined,
  contentMetadata: McpAppsResourceMetadata | undefined
): McpAppsResourceMeta | undefined {
  const listing = listingMetadata?.ui
  const content = contentMetadata?.ui
  if (!listing) return content
  if (!content) return listing
  return { ...listing, ...content }
}

function normalizeVisibility(value: unknown): McpAppsVisibility[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('_meta.ui.visibility must be a non-empty array')
  }

  const visibility: McpAppsVisibility[] = []
  for (const entry of value) {
    if (entry !== 'model' && entry !== 'app') {
      throw new TypeError('_meta.ui.visibility entries must be "model" or "app"')
    }
    if (!visibility.includes(entry)) visibility.push(entry)
  }
  return visibility
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
