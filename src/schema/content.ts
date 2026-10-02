import { isRecord } from '../internal.js'
import type { McpInputResponse } from '../types.js'
import { isValidUri } from './validate.js'

export function isMcpInputResponse(value: unknown): value is McpInputResponse {
  return isMcpElicitationResult(value) || isMcpRootsResult(value) || isMcpSamplingResult(value)
}

export function isMcpElicitationResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.action !== 'accept' && value.action !== 'decline' && value.action !== 'cancel') {
    return false
  }
  if (value.content === undefined) return true
  return (
    value.action === 'accept' &&
    isRecord(value.content) &&
    Object.values(value.content).every(
      (item) =>
        typeof item === 'string' ||
        typeof item === 'number' ||
        typeof item === 'boolean' ||
        (Array.isArray(item) && item.every((entry) => typeof entry === 'string'))
    )
  )
}

export function isMcpRootsResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.roots) &&
    value.roots.every(
      (root) =>
        isRecord(root) &&
        isValidUri(root.uri) &&
        root.uri.startsWith('file://') &&
        (root.name === undefined || typeof root.name === 'string')
    )
  )
}

export function isMcpSamplingResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.model === 'string' &&
    isSamplingContentValue(value.content) &&
    (value.stopReason === undefined || typeof value.stopReason === 'string')
  )
}

export function isSamplingContentValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSamplingContentBlock)
  return isSamplingContentBlock(value)
}

function isSamplingContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false
  const basicContent = isBasicContentBlock(value)
  if (basicContent !== undefined) return basicContent
  if (value.type === 'tool_use') {
    return typeof value.id === 'string' && typeof value.name === 'string' && isRecord(value.input)
  }
  if (value.type === 'tool_result') {
    return (
      typeof value.toolUseId === 'string' &&
      Array.isArray(value.content) &&
      value.content.every(isMcpContentBlock) &&
      (value.isError === undefined || typeof value.isError === 'boolean')
    )
  }
  return false
}

function isMcpContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false
  const basicContent = isBasicContentBlock(value)
  if (basicContent !== undefined) return basicContent
  if (value.type === 'resource_link') {
    return (
      isValidUri(value.uri) &&
      (value.name === undefined || typeof value.name === 'string') &&
      (value.description === undefined || typeof value.description === 'string') &&
      (value.mimeType === undefined || typeof value.mimeType === 'string')
    )
  }
  if (value.type === 'resource' && isRecord(value.resource)) {
    const resource = value.resource
    return (
      isValidUri(resource.uri) &&
      (resource.mimeType === undefined || typeof resource.mimeType === 'string') &&
      ((typeof resource.text === 'string' && resource.blob === undefined) ||
        (typeof resource.blob === 'string' && resource.text === undefined))
    )
  }
  return false
}

function isBasicContentBlock(value: Record<string, unknown>): boolean | undefined {
  if (value.type === 'text') return typeof value.text === 'string'
  if (value.type === 'image' || value.type === 'audio') {
    return typeof value.data === 'string' && typeof value.mimeType === 'string'
  }
  return undefined
}
