import { isRecord } from '../internal.js'
import { isValidUri } from '../schema/validate.js'
import type { McpClientInfo } from '../types.js'
import { McpProtocolError } from './protocol-error.js'

export function assertClientInfo(value: unknown): asserts value is McpClientInfo {
  if (!isRecord(value) || !validIdentity(value)) return invalidClientInfo()
  if (!optionalString(value.title) || !optionalString(value.description)) return invalidClientInfo()
  if (value.websiteUrl !== undefined && !isValidUri(value.websiteUrl)) return invalidClientInfo()
  if (value.icons !== undefined && !validIcons(value.icons)) return invalidClientInfo()
}

export function assertClientCapabilities(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new McpProtocolError(
      -32020,
      'Modern MCP requests require client capabilities in request _meta',
      400
    )
  }
  assertObjectCapabilities(value, ['elicitation', 'roots', 'sampling'])
  assertNestedCapabilities(value.elicitation, 'elicitation', ['form', 'url'])
  assertNestedCapabilities(value.sampling, 'sampling', ['context', 'tools'])
  assertRootsCapabilities(value.roots)
  assertCapabilityNamespaces(value)
}

function validIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.version === 'string' &&
    value.version.length > 0
  )
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function validIcons(value: unknown): boolean {
  return Array.isArray(value) && value.every(isIcon)
}

function isIcon(value: unknown): boolean {
  if (!isRecord(value) || !isValidUri(value.src)) return false
  if (!optionalString(value.mimeType) || !validSizes(value.sizes)) return false
  return value.theme === undefined || value.theme === 'dark' || value.theme === 'light'
}

function validSizes(value: unknown): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every((size) => typeof size === 'string'))
  )
}

function invalidClientInfo(): never {
  throw new McpProtocolError(-32020, 'clientInfo must match the MCP implementation schema', 400)
}

function assertObjectCapabilities(value: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names) {
    if (value[name] !== undefined && !isRecord(value[name])) {
      throw new McpProtocolError(-32020, `clientCapabilities.${name} must be an object`, 400)
    }
  }
}

function assertNestedCapabilities(value: unknown, name: string, features: readonly string[]): void {
  if (!isRecord(value)) return
  for (const feature of features) {
    if (value[feature] !== undefined && !isRecord(value[feature])) {
      throw new McpProtocolError(
        -32020,
        `clientCapabilities.${name}.${feature} must be an object`,
        400
      )
    }
  }
}

function assertRootsCapabilities(value: unknown): void {
  if (!isRecord(value) || value.listChanged === undefined) return
  if (typeof value.listChanged !== 'boolean') {
    throw new McpProtocolError(-32020, 'clientCapabilities.roots.listChanged must be boolean', 400)
  }
}

function assertCapabilityNamespaces(value: Record<string, unknown>): void {
  for (const namespace of ['experimental', 'extensions']) {
    const container = value[namespace]
    if (container === undefined) continue
    if (!isObjectMap(container)) {
      throw new McpProtocolError(-32020, `clientCapabilities.${namespace} must map to objects`, 400)
    }
  }
}

function isObjectMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isRecord)
}
