import { MCP_APPS_RESOURCE_MIME_TYPE } from './constants.js'
import type {
  McpAppsResourceContent,
  McpAppsResourceContentInput,
  McpAppsResourceListing,
  McpAppsResourceListingInput,
  McpAppsResourceMetadata,
  McpAppsToolMetadata,
  McpAppsValidationIssue,
  McpAppsValidationResult,
  McpAppsVisibility
} from './types.js'

type McpAppsCodecVersion = '2026-01-26' | 'draft'
const PERMISSION_NAMES = ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const
const CSP_NAMES = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const

export function isMcpAppsResourceUri(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('ui://')) return false

  try {
    const uri = new URL(value)
    return uri.protocol === 'ui:' && uri.host.length > 0
  } catch {
    return false
  }
}

export function assertMcpAppsResourceUri(
  value: unknown,
  name = 'resource URI'
): asserts value is string {
  if (!isMcpAppsResourceUri(value)) {
    throw new TypeError(`${name} must be a valid ui:// URI`)
  }
}

export function isMcpAppsResourceMimeType(
  value: unknown
): value is typeof MCP_APPS_RESOURCE_MIME_TYPE {
  return value === MCP_APPS_RESOURCE_MIME_TYPE
}

export function assertMcpAppsResourceMimeType(
  value: unknown,
  name = 'resource MIME type'
): asserts value is typeof MCP_APPS_RESOURCE_MIME_TYPE {
  if (!isMcpAppsResourceMimeType(value)) {
    throw new TypeError(`${name} must be exactly ${MCP_APPS_RESOURCE_MIME_TYPE}`)
  }
}

export function validateMcpAppsResourceListing(value: unknown): McpAppsValidationResult {
  const issues: McpAppsValidationIssue[] = []
  if (!isRecord(value)) {
    return invalidRoot('resource listing')
  }

  validateUriAndMimeType(value, issues)
  if (typeof value.name !== 'string' || value.name.length === 0) {
    issues.push({ path: 'name', message: 'must be a non-empty string' })
  }

  return { valid: issues.length === 0, issues }
}

export function validateMcpAppsResourceContent(value: unknown): McpAppsValidationResult {
  const issues: McpAppsValidationIssue[] = []
  if (!isRecord(value)) {
    return invalidRoot('resource content')
  }

  validateUriAndMimeType(value, issues)
  const hasText = typeof value.text === 'string'
  const hasBlob = typeof value.blob === 'string'
  if (hasText === hasBlob) {
    issues.push({
      path: 'content',
      message: 'must provide exactly one of text or blob'
    })
  }

  return { valid: issues.length === 0, issues }
}

export function assertMcpAppsResourceListing(
  value: unknown
): asserts value is McpAppsResourceListing {
  assertValid('MCP Apps resource listing', validateMcpAppsResourceListing(value))
}

export function assertMcpAppsResourceContent(
  value: unknown
): asserts value is McpAppsResourceContent {
  assertValid('MCP Apps resource content', validateMcpAppsResourceContent(value))
}

export function assertMcpAppsToolMetadata(
  value: unknown,
  version: McpAppsCodecVersion
): asserts value is McpAppsToolMetadata {
  assertCodecVersion(version)
  if (!isRecord(value)) throw new TypeError('MCP Apps tool metadata must be an object')
  if (value.ui === undefined) return
  if (!isRecord(value.ui)) throw new TypeError('MCP Apps tool metadata ui must be an object')
  if (value.ui.resourceUri !== undefined) {
    assertMcpAppsResourceUri(value.ui.resourceUri, '_meta.ui.resourceUri')
  }
  if (value.ui.visibility !== undefined) assertVisibility(value.ui.visibility)
}

export function assertMcpAppsResourceMetadata(
  value: unknown,
  version: McpAppsCodecVersion
): asserts value is McpAppsResourceMetadata {
  assertCodecVersion(version)
  if (!isRecord(value)) throw new TypeError('MCP Apps resource metadata must be an object')
  if (value.ui === undefined) return
  if (!isRecord(value.ui)) throw new TypeError('MCP Apps resource metadata ui must be an object')

  if (value.ui.csp !== undefined) {
    assertNamedObject(value.ui.csp, 'MCP Apps resource CSP')
    for (const name of CSP_NAMES) {
      const domains = value.ui.csp[name]
      if (
        domains !== undefined &&
        (!Array.isArray(domains) || domains.some((domain) => typeof domain !== 'string'))
      ) {
        throw new TypeError(`_meta.ui.csp.${name} must be an array of strings`)
      }
    }
  }
  if (value.ui.permissions !== undefined) {
    assertNamedObject(value.ui.permissions, 'MCP Apps resource permissions')
    for (const name of PERMISSION_NAMES) {
      const permission = value.ui.permissions[name]
      if (
        permission !== undefined &&
        (!isRecord(permission) || Object.keys(permission).length > 0)
      ) {
        throw new TypeError(`_meta.ui.permissions.${name} must be an empty object`)
      }
    }
  }
  if (value.ui.domain !== undefined && typeof value.ui.domain !== 'string') {
    throw new TypeError('_meta.ui.domain must be a string')
  }
  if (value.ui.prefersBorder !== undefined && typeof value.ui.prefersBorder !== 'boolean') {
    throw new TypeError('_meta.ui.prefersBorder must be a boolean')
  }
}

export function normalizeMcpAppsResourceListing(
  value: McpAppsResourceListingInput
): McpAppsResourceListing {
  const normalized = {
    ...value,
    mimeType: value.mimeType ?? MCP_APPS_RESOURCE_MIME_TYPE
  }
  assertMcpAppsResourceListing(normalized)
  return normalized
}

export function normalizeMcpAppsResourceContent(
  value: McpAppsResourceContentInput
): McpAppsResourceContent {
  const normalized = {
    ...value,
    mimeType: value.mimeType ?? MCP_APPS_RESOURCE_MIME_TYPE
  }
  assertMcpAppsResourceContent(normalized)
  return normalized
}

function validateUriAndMimeType(
  value: Record<string, unknown>,
  issues: McpAppsValidationIssue[]
): void {
  if (!isMcpAppsResourceUri(value.uri)) {
    issues.push({ path: 'uri', message: 'must be a valid ui:// URI' })
  }
  if (!isMcpAppsResourceMimeType(value.mimeType)) {
    issues.push({
      path: 'mimeType',
      message: `must be exactly ${MCP_APPS_RESOURCE_MIME_TYPE}`
    })
  }
}

function assertValid(label: string, result: McpAppsValidationResult): void {
  if (result.valid) return

  const details = result.issues.map(({ path, message }) => `${path} ${message}`).join('; ')
  throw new TypeError(`${label} is invalid: ${details}`)
}

function invalidRoot(label: string): McpAppsValidationResult {
  return {
    valid: false,
    issues: [{ path: '', message: `${label} must be an object` }]
  }
}

function assertCodecVersion(version: string): void {
  if (version !== '2026-01-26' && version !== 'draft') {
    throw new TypeError(`Unsupported MCP Apps codec version: ${version}`)
  }
}

function assertVisibility(value: unknown): asserts value is McpAppsVisibility[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => entry !== 'model' && entry !== 'app')
  ) {
    throw new TypeError('_meta.ui.visibility must contain only "model" or "app"')
  }
}

function assertNamedObject(
  value: unknown,
  label: string
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
