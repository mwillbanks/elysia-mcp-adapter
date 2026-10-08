import {
  MCP_SERVER_VARIANTS_REVISION,
  type McpServerVariant,
  type McpVariantsOptions
} from '../extensions/variants/index.js'
import type { NormalizedMcpPluginOptions } from '../types.js'
import { resolveExperimentalRevision } from './validation.js'

function assertVariantIdentity(variant: McpServerVariant): void {
  if (
    !variant ||
    typeof variant.id !== 'string' ||
    !variant.id ||
    typeof variant.description !== 'string' ||
    !variant.description
  ) {
    throw new TypeError('Server variant identity is invalid')
  }
}

function assertVariantStatus(variant: McpServerVariant): void {
  if (variant.status === undefined) return
  if (['stable', 'experimental', 'deprecated'].includes(variant.status)) return
  throw new TypeError(`Server variant ${variant.id} has an invalid status`)
}

function assertVariantHints(variant: McpServerVariant): void {
  if (variant.hints === undefined) return
  if (typeof variant.hints !== 'object' || Array.isArray(variant.hints)) {
    throw new TypeError(`Server variant ${variant.id} has invalid hints`)
  }
  if (Object.values(variant.hints).every((hint) => typeof hint === 'string')) return
  throw new TypeError(`Server variant ${variant.id} has invalid hints`)
}

function assertVariantRegistry(
  variant: McpServerVariant,
  kind: 'tools' | 'resources' | 'prompts'
): void {
  const entries = variant[kind]
  if (entries === undefined) return
  const entriesAreValid =
    Array.isArray(entries) &&
    entries.every((entry) => typeof entry === 'string' && entry.length > 0) &&
    new Set(entries).size === entries.length
  if (!entriesAreValid) {
    throw new TypeError(`Server variant ${variant.id} has an invalid ${kind} registry`)
  }
}

function assertDeprecationInfo(variant: McpServerVariant): void {
  const info = variant.deprecationInfo
  if (info === undefined) return
  const validRemovalDate = isValidRemovalDate(info.removalDate)
  const valid =
    info !== null &&
    typeof info === 'object' &&
    typeof info.message === 'string' &&
    info.message.length > 0 &&
    (info.replacement === undefined || typeof info.replacement === 'string') &&
    validRemovalDate
  if (!valid) throw new TypeError(`Server variant ${variant.id} has invalid deprecationInfo`)
}

function isValidRemovalDate(value: string | undefined): boolean {
  if (value === undefined) return true
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(value)) return false
  return !Number.isNaN(Date.parse(value))
}

function validateVariant(variant: McpServerVariant): void {
  assertVariantIdentity(variant)
  assertVariantStatus(variant)
  assertVariantHints(variant)
  assertVariantRegistry(variant, 'tools')
  assertVariantRegistry(variant, 'resources')
  assertVariantRegistry(variant, 'prompts')
  assertDeprecationInfo(variant)
}

function validateVariants(variants: McpServerVariant[]): void {
  if (variants.length === 0) {
    throw new TypeError('Server variants require at least one configured variant')
  }
  const ids = new Set<string>()
  for (const variant of variants) {
    validateVariant(variant)
    if (ids.has(variant.id)) throw new TypeError(`Duplicate server variant: ${variant.id}`)
    ids.add(variant.id)
  }
}

export function normalizeVariants(
  value: McpVariantsOptions | undefined
): NormalizedMcpPluginOptions['extensions']['variants'] {
  if (!value) return undefined
  if (!Array.isArray(value.variants)) {
    throw new TypeError('Server variants require at least one configured variant')
  }
  validateVariants(value.variants)
  const discoveryLimit = value.discoveryLimit ?? 5
  if (!Number.isSafeInteger(discoveryLimit) || discoveryLimit < 1) {
    throw new TypeError('Variant discoveryLimit must be positive')
  }
  return {
    ...value,
    version: resolveExperimentalRevision(
      'server variants',
      value.version,
      MCP_SERVER_VARIANTS_REVISION
    ),
    discoveryLimit
  }
}
