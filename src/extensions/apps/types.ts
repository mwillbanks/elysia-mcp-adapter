import type { MCP_APPS_RESOURCE_MIME_TYPE, MCP_APPS_RESOURCE_URI_META_KEY } from './constants.js'

export type McpAppsResourceMimeType = typeof MCP_APPS_RESOURCE_MIME_TYPE
export type McpAppsVisibility = 'model' | 'app'

export interface McpAppsResourceCsp {
  connectDomains?: string[]
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}

export interface McpAppsResourcePermissions {
  camera?: Record<string, never>
  microphone?: Record<string, never>
  geolocation?: Record<string, never>
  clipboardWrite?: Record<string, never>
}

export interface McpAppsResourceMeta {
  csp?: McpAppsResourceCsp
  permissions?: McpAppsResourcePermissions
  domain?: string
  prefersBorder?: boolean
}

export interface McpAppsToolMeta {
  resourceUri?: string
  visibility?: McpAppsVisibility[]
}

export interface McpAppsMetadata {
  ui?: McpAppsToolMeta | McpAppsResourceMeta
  [MCP_APPS_RESOURCE_URI_META_KEY]?: string
  [key: string]: unknown
}

export interface McpAppsToolMetadata extends McpAppsMetadata {
  ui?: McpAppsToolMeta
}

export interface McpAppsResourceMetadata extends McpAppsMetadata {
  ui?: McpAppsResourceMeta
}

export interface McpAppsResourceListing {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType: McpAppsResourceMimeType
  _meta?: McpAppsResourceMetadata
}

export interface McpAppsResourceListingInput extends Omit<McpAppsResourceListing, 'mimeType'> {
  mimeType?: string
}

interface McpAppsResourceContentBase {
  uri: string
  mimeType: McpAppsResourceMimeType
  _meta?: McpAppsResourceMetadata
}

export type McpAppsResourceContent =
  | (McpAppsResourceContentBase & { text: string; blob?: never })
  | (McpAppsResourceContentBase & { text?: never; blob: string })

interface McpAppsResourceContentInputBase extends Omit<McpAppsResourceContentBase, 'mimeType'> {
  mimeType?: string
}

export type McpAppsResourceContentInput =
  | (McpAppsResourceContentInputBase & { text: string; blob?: never })
  | (McpAppsResourceContentInputBase & { text?: never; blob: string })

export interface McpAppsValidationIssue {
  path: string
  message: string
}

export interface McpAppsValidationResult {
  valid: boolean
  issues: McpAppsValidationIssue[]
}
